import { type App, Modal } from "obsidian";

/**
 * "Open full report" (U5 #13): a long subagent report is kept whole as an
 * artifact; the row shows its head, and this modal shows all of it.
 */
export class SubagentReportModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly load: () => Promise<string>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    this.modalEl.addClass("agentic-chat-report-modal");
    const body = this.contentEl.createEl("pre", { cls: "agentic-chat-report-modal-body", text: "Loading…" });
    this.load().then(
      (text) => body.setText(text),
      (error: unknown) => body.setText(`Could not open the report: ${error instanceof Error ? error.message : String(error)}`),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
