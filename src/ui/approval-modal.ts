import { App, Modal, Setting, TFile } from "obsidian";
import type { ToolApprovalRequest } from "../agent/agent-service";
import { buildEditPreview, buildExactEditPreviewWindow, type EditPreview } from "../agent/edit-preview";
import { approvalPreviewNeedsContent, toolApprovalDescription } from "../tools/tool-contracts";
import { compactDiffLines, diffLines, diffStat, diffTooLarge, type CompactDiffWindow } from "../vault/diff";
import { normalizeVaultPath } from "../vault/path";

/** Cap diff lines rendered in the modal so a huge change can't bloat the dialog. */
const MAX_DIFF_DISPLAY_LINES = 400;
const DEFAULT_DIFF_CONTEXT_LINES = 5;

export interface ApprovalChoice {
  approved: boolean;
  /** Remember this decision for the tool (sets a per-tool "allow" override). */
  remember: boolean;
}

/** Confirm dialog shown when a tool's approval policy is "ask". */
export class ApprovalModal extends Modal {
  private decided = false;
  private resolve: ((choice: ApprovalChoice) => void) | null = null;

  constructor(
    app: App,
    private readonly request: ToolApprovalRequest,
  ) {
    super(app);
  }

  ask(): Promise<ApprovalChoice> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Allow "${this.request.label}"?`);
    contentEl.addClass("agentic-chat-approval");

    contentEl.createEl("p", {
      text: toolApprovalDescription(this.request.toolName),
    });
    // Render the change preview asynchronously (it reads the file from the vault);
    // show the raw arguments immediately as a fallback until it resolves.
    const previewEl = contentEl.createDiv({ cls: "agentic-chat-approval-preview" });
    previewEl.createEl("pre", { cls: "agentic-chat-approval-args", text: previewArgs(this.request.args) });
    void this.renderPreview(previewEl);

    let remember = false;
    const rememberSetting = new Setting(contentEl)
      .setName("Don't ask again for this tool")
      .setDesc("After you choose Allow or Deny, remember that decision for this tool. Changeable in settings.")
      .addToggle((toggle) => toggle.setValue(false).onChange((value) => (remember = value)));
    for (const eventName of ["click", "mousedown", "mouseup", "keydown"]) {
      rememberSetting.settingEl.addEventListener(eventName, (event) => event.stopPropagation());
    }

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Deny")
          .setClass("mod-warning")
          .onClick(() => this.decide({ approved: false, remember })),
      )
      .addButton((button) =>
        button
          .setButtonText("Allow")
          .setCta()
          .onClick(() => this.decide({ approved: true, remember })),
      );

    // Enter accepts (Escape already dismisses via the default modal handler).
    // Let a focused button handle Enter itself so Tab-to-Deny still works.
    this.scope.register([], "Enter", (event) => {
      if (this.decided || isInteractiveElement(activeDocument.activeElement)) return;
      event.preventDefault();
      this.decide({ approved: true, remember });
      return false;
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.resolve?.({ approved: false, remember: false });
  }

  /** Read the target file and render a structured preview of the pending change. */
  private async renderPreview(container: HTMLElement): Promise<void> {
    const rawPath = (this.request.args as { path?: unknown })?.path;
    const path = typeof rawPath === "string" ? rawPath : "";
    let current: string | null = null;
    // Only preview types that need a body pay the cachedRead cost; rename and
    // structured property updates can render from arguments alone.
    const needsContent = approvalPreviewNeedsContent(this.request.toolName);
    if (path && needsContent) {
      const file = this.app.vault.getAbstractFileByPath(normalizeVaultPath(path));
      if (file instanceof TFile) {
        try {
          current = await this.app.vault.cachedRead(file);
        } catch {
          current = null;
        }
      }
    }
    // The modal may have been dismissed while we were reading the file.
    if (this.decided) return;
    const preview = buildEditPreview(this.request.toolName, this.request.args, current);
    if (preview.kind === "none") return; // keep the raw-args fallback already shown
    container.empty();
    this.renderPreviewBody(container, preview);
  }

  private renderPreviewBody(container: HTMLElement, preview: EditPreview): void {
    if (preview.kind === "rename") {
      container.createEl("p", { cls: "agentic-chat-approval-summary", text: `Rename ${preview.from} → ${preview.to}` });
      return;
    }
    if (preview.kind === "delete") {
      container.createEl("p", { cls: "agentic-chat-approval-summary", text: `Move ${preview.path} to trash` });
      this.renderDiff(container, preview.content, "");
      return;
    }
    if (preview.kind !== "diff") return;
    const verb = preview.isNew ? "Create" : "Edit";
    container.createEl("p", { cls: "agentic-chat-approval-summary", text: `${verb} ${preview.path}` });
    this.renderDiff(container, preview.before, preview.after, preview.edits);
  }

  /** Render a line-level diff, or a compact summary when the change is too large. */
  private renderDiff(container: HTMLElement, before: string, after: string, edits?: EditPreviewEdit[]): void {
    if (edits?.length && this.renderExactEditDiff(container, before, edits)) return;
    if (diffTooLarge(before, after)) {
      const beforeLines = before ? before.split("\n").length : 0;
      const afterLines = after ? after.split("\n").length : 0;
      container.createEl("p", {
        cls: "agentic-chat-approval-summary",
        text: `Large change: ${beforeLines} → ${afterLines} lines (diff omitted).`,
      });
      return;
    }
    const lines = diffLines(before, after);
    const stat = diffStat(lines);
    container.createEl("p", {
      cls: "agentic-chat-approval-summary",
      text: `+${stat.added} −${stat.removed}`,
    });
    const diffEl = container.createDiv({ cls: "agentic-chat-diff-window" });
    let contextBefore = DEFAULT_DIFF_CONTEXT_LINES;
    let contextAfter = DEFAULT_DIFF_CONTEXT_LINES;
    const renderWindow = () => {
      const windowed = compactDiffLines(lines, {
        contextBefore,
        contextAfter,
        maxLines: MAX_DIFF_DISPLAY_LINES,
      });
      diffEl.empty();
      const pre = diffEl.createEl("pre", { cls: "agentic-chat-diff" });
      this.renderDiffWindow(pre, windowed, {
        expandAbove: () => {
          contextBefore += DEFAULT_DIFF_CONTEXT_LINES;
          renderWindow();
        },
        expandBelow: () => {
          contextAfter += DEFAULT_DIFF_CONTEXT_LINES;
          renderWindow();
        },
      });
    };
    renderWindow();
  }

  private renderExactEditDiff(container: HTMLElement, before: string, edits: EditPreviewEdit[]): boolean {
    let contextBefore = DEFAULT_DIFF_CONTEXT_LINES;
    let contextAfter = DEFAULT_DIFF_CONTEXT_LINES;
    const initial = buildExactEditPreviewWindow(before, edits, { contextBefore, contextAfter });
    if (!initial) return false;
    let lines = diffLines(initial.before, initial.after);
    let stat = diffStat(lines);
    const summary = container.createEl("p", {
      cls: "agentic-chat-approval-summary",
      text: `+${stat.added} −${stat.removed}`,
    });
    const diffEl = container.createDiv({ cls: "agentic-chat-diff-window" });
    const renderWindow = () => {
      const windowed = buildExactEditPreviewWindow(before, edits, { contextBefore, contextAfter });
      if (!windowed) return;
      lines = diffLines(windowed.before, windowed.after);
      stat = diffStat(lines);
      summary.setText(`+${stat.added} −${stat.removed}`);
      diffEl.empty();
      const pre = diffEl.createEl("pre", { cls: "agentic-chat-diff" });
      if (windowed.hiddenBefore > 0) {
        this.renderDiffExpandButton(pre, "above", windowed.hiddenBefore, () => {
          contextBefore += DEFAULT_DIFF_CONTEXT_LINES;
          renderWindow();
        });
      }
      for (const line of lines) {
        const prefix = diffPrefix(line.op);
        pre.createDiv({ cls: `agentic-chat-diff-line is-${line.op}`, text: `${prefix} ${line.text}` });
      }
      if (windowed.hiddenAfter > 0) {
        this.renderDiffExpandButton(pre, "below", windowed.hiddenAfter, () => {
          contextAfter += DEFAULT_DIFF_CONTEXT_LINES;
          renderWindow();
        });
      }
    };
    renderWindow();
    return true;
  }

  private renderDiffWindow(
    container: HTMLElement,
    windowed: CompactDiffWindow,
    callbacks: { expandAbove: () => void; expandBelow: () => void },
  ): void {
    if (windowed.hiddenBefore > 0) {
      this.renderDiffExpandButton(container, "above", windowed.hiddenBefore, callbacks.expandAbove);
    }
    for (const line of windowed.lines) {
      const prefix = diffPrefix(line.op);
      container.createDiv({ cls: `agentic-chat-diff-line is-${line.op}`, text: `${prefix} ${line.text}` });
    }
    if (windowed.hiddenAfter > 0) {
      this.renderDiffExpandButton(container, "below", windowed.hiddenAfter, callbacks.expandBelow);
    }
  }

  private renderDiffExpandButton(
    container: HTMLElement,
    direction: "above" | "below",
    hiddenLines: number,
    onClick: () => void,
  ): void {
    const count = Math.min(DEFAULT_DIFF_CONTEXT_LINES, hiddenLines);
    const button = container.createEl("button", {
      cls: "agentic-chat-diff-expand",
      text: `Show ${count} more line${count === 1 ? "" : "s"} ${direction}`,
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
  }

  private decide(choice: ApprovalChoice): void {
    this.decided = true;
    this.resolve?.(choice);
    this.close();
  }
}

type EditPreviewEdit = NonNullable<Extract<EditPreview, { kind: "diff" }>["edits"]>[number];

function isInteractiveElement(element: Element | null): boolean {
  return (
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    element?.getAttribute("role") === "button" ||
    element?.getAttribute("role") === "checkbox" ||
    element?.getAttribute("contenteditable") === "true"
  );
}

function previewArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args, null, 2);
  } catch {
    text = String(args);
  }
  text ??= "(no arguments)";
  return text.length > 2_000 ? `${text.slice(0, 2_000)}\n…` : text;
}

function diffPrefix(op: string): string {
  if (op === "add") return "+";
  if (op === "remove") return "-";
  return " ";
}
