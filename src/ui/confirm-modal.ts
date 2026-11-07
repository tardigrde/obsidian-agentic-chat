import { App, ButtonComponent, Modal, Setting } from "obsidian";

export interface ConfirmModalOptions {
  title: string;
  message: string;
  /** Confirm button label. Defaults to "Confirm". */
  confirmText?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelText?: string;
  /** Style the confirm button as a destructive action. */
  destructive?: boolean;
}

/**
 * Ask for a yes/no decision with an Obsidian Modal. The returned promise
 * resolves true only when the user presses the confirm button; closing the
 * modal any other way resolves false.
 *
 * The base Modal class handles the focus trap, Escape, and the scrim. All DOM
 * is built through Obsidian's own Setting/ButtonComponent helpers, so it is
 * safe in a popout window.
 */
export function confirmWithModal(app: App, options: ConfirmModalOptions): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmModal(app, options, resolve).open();
  });
}

class ConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly options: ConfirmModalOptions,
    private readonly resolve: (value: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.options.title);
    this.contentEl.createEl("p", { text: this.options.message });

    new Setting(this.contentEl)
      .addButton((button) => {
        button.setButtonText(this.options.cancelText ?? "Cancel").onClick(() => this.settle(false));
        this.focusOnOpen(button);
      })
      .addButton((button) => {
        button
          .setButtonText(this.options.confirmText ?? "Confirm")
          .setCta()
          .onClick(() => this.settle(true));
        if (this.options.destructive) button.setDestructive();
      });
  }

  onClose(): void {
    this.contentEl.empty();
    // Escape, the scrim, or the close control must settle the promise too.
    this.settle(false);
  }

  private settle(value: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(value);
    this.close();
  }

  /** Move focus to the safe choice once the modal is attached. */
  private focusOnOpen(button: ButtonComponent): void {
    queueMicrotask(() => button.buttonEl.focus());
  }
}
