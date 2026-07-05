import { App, Modal } from "obsidian";
import { diffLines, diffStat, diffTooLarge } from "../vault/diff";
import { buildQuickAskProposal, type QuickAskProposal, type QuickAskTarget } from "./quick-ask";

const MAX_DIFF_DISPLAY_LINES = 400;

export class QuickAskModal extends Modal {
  private proposal: QuickAskProposal | null = null;

  constructor(
    app: App,
    private readonly target: QuickAskTarget,
    private readonly onAccept: (proposal: QuickAskProposal) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Quick Ask");
    contentEl.addClass("agentic-chat-quick-ask");

    contentEl.createEl("p", {
      cls: "agentic-chat-quick-ask-target",
      text: this.target.path
        ? `${this.target.kind === "selection" ? "Selection" : "Line"} in ${this.target.path}`
        : this.target.kind === "selection"
          ? "Selection"
          : "Line",
    });

    const input = contentEl.createEl("textarea", {
      cls: "agentic-chat-quick-ask-instruction",
      attr: { rows: "3", placeholder: "Instruction" },
    });
    const preview = contentEl.createDiv({ cls: "agentic-chat-quick-ask-preview" });
    const actions = contentEl.createDiv({ cls: "agentic-chat-quick-ask-actions" });
    const reject = actions.createEl("button", { text: "Reject", cls: "agentic-chat-quick-ask-reject" });
    const accept = actions.createEl("button", { text: "Accept", cls: "agentic-chat-quick-ask-accept mod-cta" });
    accept.disabled = true;

    const update = (): void => {
      this.proposal = buildQuickAskProposal(this.target, input.value);
      preview.empty();
      if (!this.proposal) {
        accept.disabled = true;
        preview.createEl("p", { cls: "agentic-chat-quick-ask-empty", text: "No edit available." });
        return;
      }
      accept.disabled = false;
      preview.createEl("p", { cls: "agentic-chat-quick-ask-summary", text: this.proposal.summary });
      renderQuickAskDiff(preview, this.target.text, this.proposal.replacement);
    };

    input.addEventListener("input", update);
    reject.addEventListener("click", () => this.close());
    accept.addEventListener("click", () => {
      if (!this.proposal) return;
      this.onAccept(this.proposal);
      this.close();
    });
    this.scope.register([], "Enter", (event) => {
      if (event.shiftKey || !this.proposal) return;
      event.preventDefault();
      this.onAccept(this.proposal);
      this.close();
      return false;
    });
    update();
    input.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function renderQuickAskDiff(container: HTMLElement, before: string, after: string): void {
  if (diffTooLarge(before, after)) {
    const beforeLines = before ? before.split("\n").length : 0;
    const afterLines = after ? after.split("\n").length : 0;
    container.createEl("p", {
      cls: "agentic-chat-quick-ask-summary",
      text: `Large change: ${beforeLines} -> ${afterLines} lines.`,
    });
    return;
  }
  const lines = diffLines(before, after);
  const stat = diffStat(lines);
  container.createEl("p", {
    cls: "agentic-chat-quick-ask-summary",
    text: `+${stat.added} -${stat.removed}`,
  });
  const pre = container.createEl("pre", { cls: "agentic-chat-diff" });
  const shown = lines.slice(0, MAX_DIFF_DISPLAY_LINES);
  for (const line of shown) {
    const prefix = line.op === "add" ? "+" : line.op === "remove" ? "-" : " ";
    pre.createDiv({ cls: `agentic-chat-diff-line is-${line.op}`, text: `${prefix} ${line.text}` });
  }
  if (lines.length > shown.length) {
    pre.createDiv({ cls: "agentic-chat-diff-line is-context", text: `... ${lines.length - shown.length} more lines` });
  }
}
