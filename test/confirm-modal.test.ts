import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  buttons: [] as Array<{ text: string; click: () => void }>,
  modals: [] as Array<{ close: () => void }>,
}));

vi.mock("obsidian", () => {
  class ButtonComponent {
    text = "";
    buttonEl = { focus: vi.fn() };
    private callback: (() => void) | undefined;

    setButtonText(text: string): this {
      this.text = text;
      return this;
    }
    setCta(): this {
      return this;
    }
    setDestructive(): this {
      return this;
    }
    onClick(callback: () => void): this {
      this.callback = callback;
      return this;
    }
    click(): void {
      this.callback?.();
    }
  }

  class Setting {
    constructor(_container: unknown) {}
    addButton(build: (button: ButtonComponent) => void): this {
      const button = new ButtonComponent();
      build(button);
      harness.buttons.push(button);
      return this;
    }
  }

  class Modal {
    contentEl = { empty: vi.fn(), createEl: vi.fn() };
    title = "";

    constructor(public app: unknown) {
      harness.modals.push(this);
    }
    setTitle(title: string): this {
      this.title = title;
      return this;
    }
    open(): void {
      (this as unknown as { onOpen: () => void }).onOpen();
    }
    close(): void {
      (this as unknown as { onClose: () => void }).onClose();
    }
  }

  return { App: class {}, ButtonComponent, Modal, Setting };
});

import { confirmWithModal } from "../src/ui/confirm-modal";

describe("confirmWithModal", () => {
  it("resolves true only when the confirm button is pressed", async () => {
    harness.buttons.length = 0;
    harness.modals.length = 0;
    const decision = confirmWithModal({} as never, {
      title: "Replace existing skill package?",
      message: "A plugin already exists.",
      confirmText: "Replace",
      destructive: true,
    });

    expect(harness.buttons.map((button) => button.text)).toEqual(["Cancel", "Replace"]);
    harness.buttons[1].click();
    await expect(decision).resolves.toBe(true);
  });

  it("resolves false when cancelled", async () => {
    harness.buttons.length = 0;
    harness.modals.length = 0;
    const decision = confirmWithModal({} as never, {
      title: "Replace?",
      message: "Continue?",
    });

    harness.buttons[0].click();
    await expect(decision).resolves.toBe(false);
  });

  it("resolves false when the modal closes without a choice", async () => {
    harness.buttons.length = 0;
    harness.modals.length = 0;
    const decision = confirmWithModal({} as never, {
      title: "Replace?",
      message: "Continue?",
    });

    harness.modals[0].close();
    await expect(decision).resolves.toBe(false);
  });
});
