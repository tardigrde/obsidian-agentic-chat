import { setIcon, TFile, type App } from "obsidian";
import type { ToolApprovalRequest } from "../agent/agent-service";
import { STOPPED_APPROVAL_REASON, type UserApprovalChoice } from "../agent/tool-call-controller";
import { buildEditPreview, buildExactEditPreviewWindow, type EditPreview } from "../agent/edit-preview";
import { slugifyPluginName } from "../plugins/manifest";
import { approvalPreviewNeedsContent, toolApprovalDescription } from "../tools/tool-contracts";
import { compactDiffLines, diffLines, diffPrefix, diffStat, diffTooLarge, type CompactDiffWindow, type DiffLine } from "../vault/diff";
import { normalizeVaultPath } from "../vault/path";
import { acHook } from "./test-hooks";
import { isVaultFolder } from "./vault-open";

/** Cap diff lines rendered in the card so a huge change cannot bloat the transcript. */
export const MAX_DIFF_DISPLAY_LINES = 400;
const DEFAULT_DIFF_CONTEXT_LINES = 5;

/**
 * Lifecycle of one inline approval. `settled` is terminal: the promise has
 * resolved and no later click, key, abort, or tab close can change the choice.
 *
 *   open ──Deny / Esc──▶ deny-armed      (Esc in the reason: back to open)
 *   open | deny-armed ──choice, Stop, abort, close──▶ settled
 */
export type ApprovalCardPhase = "open" | "deny-armed" | "settled";

/** What the resolved card says, in one muted line. */
export type ApprovalOutcome = "allowed" | "always" | "denied" | "stopped";

export interface ApprovalCardOptions {
  app: App;
  request: ToolApprovalRequest;
  signal?: AbortSignal;
  /** Phase or outcome changed (the view syncs the tab dot and the activity line). */
  onChange?: (card: ApprovalCard) => void;
}

/**
 * The approval for one tool call, rendered in the transcript below the turn's
 * activity line: title, a one-line description, the diff, and Allow /
 * Always allow / Deny. Enter allows; Esc starts the two-step deny. The element
 * outlives a tab switch: the view moves it back in when the tab shows again.
 */
export class ApprovalCard {
  readonly el: HTMLElement;
  readonly choice: Promise<UserApprovalChoice>;
  private phaseValue: ApprovalCardPhase = "open";
  private outcomeValue: ApprovalOutcome | null = null;
  private resolveChoice!: (choice: UserApprovalChoice) => void;
  private readonly request: ToolApprovalRequest;
  private readonly app: App;
  private readonly signal?: AbortSignal;
  private readonly onAbort: () => void;
  private headIcon!: HTMLElement;
  private titleEl!: HTMLElement;
  private descEl: HTMLElement | null = null;
  private bodyEl!: HTMLElement;
  private actionsEl!: HTMLElement;
  private denyButton!: HTMLButtonElement;
  private reasonWrap!: HTMLElement;
  private reasonInput!: HTMLTextAreaElement;

  constructor(private readonly options: ApprovalCardOptions) {
    this.request = options.request;
    this.app = options.app;
    this.signal = options.signal;
    this.choice = new Promise((resolve) => (this.resolveChoice = resolve));
    this.el = acHook(createDiv({ cls: "agentic-chat-approval", attr: { tabindex: "-1", role: "group" } }), "approval");
    this.el.setAttribute("data-ac-state", "open");
    this.render();
    this.onAbort = () => this.stop();
    if (this.signal?.aborted) this.stop();
    else this.signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  get phase(): ApprovalCardPhase {
    return this.phaseValue;
  }

  get outcome(): ApprovalOutcome | null {
    return this.outcomeValue;
  }

  get settled(): boolean {
    return this.phaseValue === "settled";
  }

  /**
   * Take focus so Enter and Esc work, unless the user is typing in the
   * composer or is inside another approval card (parallel tools can ask at
   * once: an Enter meant for card A must never allow card B).
   */
  focus(composerHasText: boolean): void {
    if (this.settled || composerHasText) return;
    const active = this.el.ownerDocument.activeElement;
    const otherCard = active?.closest?.('[data-ac="approval"]');
    if (otherCard && otherCard !== this.el) return;
    this.el.focus({ preventScroll: true });
  }

  /** Stop, abort, or a closing tab: settle as stopped. */
  stop(): void {
    this.finish({ approved: false, remember: false, reason: STOPPED_APPROVAL_REASON, stopped: true }, "stopped");
  }

  private render(): void {
    const head = this.el.createDiv({ cls: "agentic-chat-approval-head" });
    this.headIcon = head.createSpan({ cls: ["agentic-chat-status-icon", "is-needs-you"], attr: { "aria-hidden": "true" } });
    setIcon(this.headIcon, "hand");
    this.titleEl = head.createSpan({ cls: "agentic-chat-approval-title", text: this.request.label });
    this.bodyEl = this.el.createDiv({ cls: "agentic-chat-approval-body" });
    if (this.isCreateSkill()) {
      this.bodyEl.createEl("p", {
        cls: "agentic-chat-approval-warning",
        text: "This creates a persistent skill package that loads into future sessions. Review the full body below — anything pasted from the web or another skill stays active until removed.",
      });
    }
    this.descEl = this.bodyEl.createDiv({ cls: "agentic-chat-approval-desc", text: toolApprovalDescription(this.request.toolName) });
    const preview = this.bodyEl.createDiv({ cls: "agentic-chat-approval-preview" });
    if (this.isCreateSkill()) this.renderCreateSkillPreview(preview);
    else {
      preview.createEl("pre", { cls: "agentic-chat-approval-args", text: previewArgs(this.request.args) });
      void this.renderPreview(preview);
    }

    this.reasonWrap = this.bodyEl.createDiv({ cls: "agentic-chat-deny-reason" });
    this.reasonWrap.hide();
    this.reasonInput = this.reasonWrap.createEl("textarea", {
      cls: "agentic-chat-deny-reason-input",
      attr: { placeholder: "Optional reason sent to the agent", rows: "2", "aria-label": "Reason for denying" },
    });
    this.reasonInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        this.deny();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.disarmDeny();
      }
    });

    this.actionsEl = this.el.createDiv({ cls: "agentic-chat-approval-actions" });
    const allow = acHook(this.button("Allow", ["mod-cta"]), "approval-allow");
    allow.addEventListener("click", () => this.finish({ approved: true, remember: false }, "allowed"));
    // A persistent skill write never offers "always": one fatigued click would
    // approve every future skill write.
    if (!this.isCreateSkill()) {
      const always = acHook(this.button(`Always allow ${this.request.toolName}`, []), "approval-always");
      always.setAttr("title", "Allow now and stop asking for this tool. Changeable in settings.");
      always.addEventListener("click", () => this.finish({ approved: true, remember: true }, "always"));
    } else {
      this.bodyEl.createEl("p", { cls: "agentic-chat-approval-note", text: "This decision cannot be remembered — each use asks again." });
    }
    this.denyButton = acHook(this.button("Deny", ["agentic-chat-approval-deny"]), "approval-deny");
    this.denyButton.addEventListener("click", () => {
      if (this.phaseValue === "deny-armed") this.deny();
      else this.armDeny();
    });
    this.actionsEl.createSpan({ cls: "agentic-chat-approval-kbd", text: "⏎ allow · Esc deny" });

    this.el.addEventListener("keydown", (event) => this.onKey(event));
  }

  /**
   * The head names the concrete action once the preview knows it: the verb,
   * then the path in accent, as in the design. The head wraps, so a long path
   * is never cut on a phone; the full text also stays in the tooltip.
   */
  private setTitle(verb: string, path: string, tail = ""): void {
    this.titleEl.empty();
    this.titleEl.appendText(`${verb} `);
    const pathEl = this.titleEl.createSpan({ cls: "agentic-chat-approval-path", text: path });
    if (isVaultFolder(this.app, path)) {
      // A folder is not a note: plain text with a folder icon (U3 #4).
      pathEl.addClass("is-folder");
      const icon = createSpan({ cls: "agentic-chat-approval-path-icon", attr: { "aria-hidden": "true" } });
      setIcon(icon, "folder");
      pathEl.prepend(icon);
    }
    if (tail) this.titleEl.appendText(tail);
    this.titleEl.setAttr("title", `${verb} ${path}${tail}`);
  }

  private button(text: string, cls: string[]): HTMLButtonElement {
    return this.actionsEl.createEl("button", { cls: ["agentic-chat-approval-button", ...cls], text, attr: { type: "button" } });
  }

  private onKey(event: KeyboardEvent): void {
    if (this.settled || event.isComposing) return;
    const target = event.target as HTMLElement | null;
    const inField = !!target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");
    const onButton = !!target && target.tagName === "BUTTON";
    if (event.key === "Enter" && !inField && !onButton) {
      event.preventDefault();
      // With the deny armed, Enter confirms the deny, never an allow.
      if (this.phaseValue === "deny-armed") this.deny();
      else this.finish({ approved: true, remember: false }, "allowed");
    } else if (event.key === "Escape" && !inField) {
      event.preventDefault();
      if (this.phaseValue === "deny-armed") this.disarmDeny();
      else this.armDeny();
    }
  }

  /** Two-step deny: the first Deny or Esc shows an optional reason field. */
  private armDeny(): void {
    if (this.phaseValue !== "open") return;
    this.phaseValue = "deny-armed";
    this.el.setAttribute("data-ac-state", "deny-armed");
    this.reasonWrap.show();
    this.denyButton.setText("Confirm deny");
    this.reasonInput.focus();
    this.options.onChange?.(this);
  }

  private disarmDeny(): void {
    if (this.phaseValue !== "deny-armed") return;
    this.phaseValue = "open";
    this.el.setAttribute("data-ac-state", "open");
    this.reasonWrap.hide();
    this.reasonInput.value = "";
    this.denyButton.setText("Deny");
    this.el.focus({ preventScroll: true });
    this.options.onChange?.(this);
  }

  private deny(): void {
    this.finish({ approved: false, remember: false, reason: this.reasonInput.value.trim() || undefined }, "denied");
  }

  /** The one transition into `settled`; a second call is a no-op. */
  private finish(choice: UserApprovalChoice, outcome: ApprovalOutcome): void {
    if (this.phaseValue === "settled") return;
    this.phaseValue = "settled";
    this.outcomeValue = outcome;
    this.signal?.removeEventListener("abort", this.onAbort);
    this.collapse(outcome);
    this.resolveChoice(choice);
    this.options.onChange?.(this);
  }

  /** The resolved card stays as one muted line, a record of the decision. */
  private collapse(outcome: ApprovalOutcome): void {
    // A settled card gives focus up, so the view can hand it to the next
    // waiting card (or the user's own place) instead of a dead record.
    const active = this.el.ownerDocument.activeElement as HTMLElement | null;
    if (active && this.el.contains(active)) active.blur();
    this.el.addClass("is-resolved");
    this.el.setAttribute("data-ac-state", outcome);
    this.el.removeAttribute("tabindex");
    this.bodyEl.remove();
    this.actionsEl.empty();
    const text: Record<ApprovalOutcome, string> = {
      allowed: "Allowed once",
      always: `Allowed: always for ${this.request.toolName}`,
      denied: "Denied",
      stopped: "Stopped",
    };
    this.actionsEl.createSpan({ cls: "agentic-chat-approval-outcome", text: text[outcome] });
    this.headIcon.removeClass("is-needs-you");
    this.headIcon.addClass(outcome === "allowed" || outcome === "always" ? "is-done" : "is-error");
    setIcon(this.headIcon, outcome === "allowed" || outcome === "always" ? "check-circle-2" : "x-circle");
  }

  private isCreateSkill(): boolean {
    return this.request.toolName === "create_skill";
  }

  /** Full-body preview for create_skill: slug, package path, and the whole body. */
  private renderCreateSkillPreview(container: HTMLElement): void {
    const raw = (this.request.args ?? {}) as { name?: unknown; description?: unknown; body?: unknown; overwrite?: unknown };
    const requested = typeof raw.name === "string" ? raw.name.trim() : "";
    const slug = slugifyPluginName(requested);
    const description = typeof raw.description === "string" ? raw.description : "";
    const body = typeof raw.body === "string" ? raw.body : "";
    const overwrite = raw.overwrite === true;
    const slugNote = slug !== requested.toLowerCase() ? ` (from "${requested}")` : "";
    container.createEl("p", {
      cls: "agentic-chat-approval-summary",
      text: `Create skill "${slug}"${slugNote} → .agentic-plugins/${slug}/skills/${slug}/SKILL.md${overwrite ? " (REPLACE existing package)" : ""}`,
    });
    if (description) container.createEl("p", { cls: "agentic-chat-approval-summary", text: `Description: ${description}` });
    container.createDiv({ cls: "agentic-chat-approval-skill-body" }).createEl("pre", { cls: "agentic-chat-approval-args", text: body || "(empty body)" });
  }

  /** Read the target file and render the change; the raw arguments show until then. */
  private async renderPreview(container: HTMLElement): Promise<void> {
    const rawPath = (this.request.args as { path?: unknown })?.path;
    const path = typeof rawPath === "string" ? rawPath : "";
    let current: string | null = null;
    if (path && approvalPreviewNeedsContent(this.request.toolName)) {
      const file = this.app.vault.getAbstractFileByPath(normalizeVaultPath(path));
      if (file instanceof TFile) {
        try {
          current = await this.app.vault.cachedRead(file);
        } catch {
          current = null;
        }
      }
    }
    if (this.settled) return;
    const preview = buildEditPreview(this.request.toolName, this.request.args, current);
    if (preview.kind === "none") return;
    container.empty();
    // A concrete preview says what happens, so the generic tool description goes.
    this.descEl?.remove();
    this.renderPreviewBody(container, preview);
  }

  private renderPreviewBody(container: HTMLElement, preview: EditPreview): void {
    if (preview.kind === "rename") {
      this.setTitle("Rename", preview.from, ` → ${preview.to}`);
      return;
    }
    if (preview.kind === "delete") {
      this.setTitle("Move", preview.path, " to trash");
      this.renderDiff(container, preview.content, "");
      return;
    }
    if (preview.kind !== "diff") return;
    this.setTitle(preview.isNew ? "Create" : "Edit", preview.path);
    this.renderDiff(container, preview.before, preview.after, preview.edits);
  }

  /** A line diff, or a short summary when the change is too large. */
  private renderDiff(container: HTMLElement, before: string, after: string, edits?: EditPreviewEdit[]): void {
    if (edits?.length && this.renderExactEditDiff(container, before, edits)) return;
    if (diffTooLarge(before, after)) {
      const beforeLines = before ? before.split("\n").length : 0;
      const afterLines = after ? after.split("\n").length : 0;
      container.createEl("p", { cls: "agentic-chat-approval-summary", text: `Large change: ${beforeLines} → ${afterLines} lines (diff omitted).` });
      return;
    }
    const lines = diffLines(before, after);
    const stat = diffStat(lines);
    container.createEl("p", { cls: "agentic-chat-approval-summary", text: `+${stat.added} −${stat.removed}` });
    const diffEl = container.createDiv({ cls: "agentic-chat-diff-window" });
    let contextBefore = DEFAULT_DIFF_CONTEXT_LINES;
    let contextAfter = DEFAULT_DIFF_CONTEXT_LINES;
    const renderWindow = () => {
      const windowed = compactDiffLines(lines, { contextBefore, contextAfter, maxLines: MAX_DIFF_DISPLAY_LINES });
      diffEl.empty();
      this.renderDiffWindow(diffEl.createEl("pre", { cls: "agentic-chat-diff" }), windowed, {
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
    // A huge changed region would make diffLines throw: fall back to the plain
    // path, which shows "Large change … (diff omitted)".
    if (!initial || diffTooLarge(initial.before, initial.after)) return false;
    const stat = diffStat(diffLines(initial.before, initial.after));
    // Where the change lands, as in the design: `+6 −1 · in "Next steps"`.
    // Only when every edit is in the same section; otherwise no hint.
    const sections = new Set(edits.map((edit) => sectionAbove(before, edit.oldText)));
    const [only] = sections;
    const section = sections.size === 1 ? only : undefined;
    const statText = (added: number, removed: number) => `+${added} −${removed}${section ? ` · in "${section}"` : ""}`;
    const summary = container.createEl("p", { cls: "agentic-chat-approval-summary", text: statText(stat.added, stat.removed) });
    const diffEl = container.createDiv({ cls: "agentic-chat-diff-window" });
    const renderWindow = () => {
      const windowed = buildExactEditPreviewWindow(before, edits, { contextBefore, contextAfter });
      if (!windowed) return;
      // The window grew too large to diff: keep what is shown and remove the
      // "Show more" buttons, so no button is left that does nothing.
      if (diffTooLarge(windowed.before, windowed.after)) {
        diffEl.querySelectorAll(".agentic-chat-diff-expand").forEach((button) => button.remove());
        return;
      }
      const lines = diffLines(windowed.before, windowed.after);
      const next = diffStat(lines);
      summary.setText(statText(next.added, next.removed));
      diffEl.empty();
      const pre = diffEl.createEl("pre", { cls: "agentic-chat-diff" });
      if (windowed.hiddenBefore > 0) {
        this.renderDiffExpandButton(pre, "above", windowed.hiddenBefore, () => {
          contextBefore += DEFAULT_DIFF_CONTEXT_LINES;
          renderWindow();
        });
      }
      renderApprovalDiffLines(pre, lines);
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
    if (windowed.hiddenBefore > 0) this.renderDiffExpandButton(container, "above", windowed.hiddenBefore, callbacks.expandAbove);
    renderApprovalDiffLines(container, windowed.lines);
    if (windowed.hiddenAfter > 0) this.renderDiffExpandButton(container, "below", windowed.hiddenAfter, callbacks.expandBelow);
  }

  private renderDiffExpandButton(container: HTMLElement, direction: "above" | "below", hiddenLines: number, onClick: () => void): void {
    const count = Math.min(DEFAULT_DIFF_CONTEXT_LINES, hiddenLines);
    const button = container.createEl("button", {
      cls: "agentic-chat-diff-expand",
      text: `Show ${count} more line${count === 1 ? "" : "s"} ${direction}`,
      attr: { type: "button" },
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
  }
}

/**
 * The nearest Markdown heading above the first changed text, or undefined.
 * Code fences are not parsed: a `#` line inside a fence can be taken as a
 * heading, which only affects this one-line hint.
 */
export function sectionAbove(content: string, changedText: string | undefined): string | undefined {
  if (!changedText) return undefined;
  const at = content.indexOf(changedText);
  if (at < 0) return undefined;
  const lines = content.slice(0, at).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (heading) return heading[1].length > 40 ? `${heading[1].slice(0, 39)}…` : heading[1];
  }
  return undefined;
}

type EditPreviewEdit = NonNullable<Extract<EditPreview, { kind: "diff" }>["edits"]>[number];

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

/** Render approval diff lines with their own scoped class. */
export function renderApprovalDiffLines(container: HTMLElement, lines: readonly DiffLine[]): void {
  for (const line of lines) {
    container.createDiv({ cls: `agentic-chat-approval-diff-line is-${line.op}`, text: `${diffPrefix(line.op)} ${line.text}` });
  }
}
