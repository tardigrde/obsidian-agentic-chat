import { App, Modal, Setting } from "obsidian";
import type { ToolApprovalRequest } from "../agent/agent-service";

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
      text: `The agent wants to run the ${this.request.toolName} tool. Review the arguments before allowing it.`,
    });
    const pre = contentEl.createEl("pre", { cls: "agentic-chat-approval-args" });
    pre.setText(previewArgs(this.request.args));

    let remember = false;
    new Setting(contentEl)
      .setName("Don't ask again for this tool")
      .setDesc("Always allow this tool for now on (changeable in settings).")
      .addToggle((toggle) => toggle.setValue(false).onChange((value) => (remember = value)));

    new Setting(contentEl)
      .addButton((button) =>
        button.setButtonText("Deny").setWarning().onClick(() => this.decide({ approved: false, remember: false })),
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
      if (this.decided || document.activeElement instanceof HTMLButtonElement) return;
      event.preventDefault();
      this.decide({ approved: true, remember });
      return false;
    });
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.decided) this.resolve?.({ approved: false, remember: false });
  }

  private decide(choice: ApprovalChoice): void {
    this.decided = true;
    this.resolve?.(choice);
    this.close();
  }
}

function previewArgs(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args, null, 2);
  } catch {
    text = String(args);
  }
  if (text === undefined) text = "(no arguments)";
  return text.length > 2_000 ? `${text.slice(0, 2_000)}\n…` : text;
}
