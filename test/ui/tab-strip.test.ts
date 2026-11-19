import { afterEach, describe, expect, it } from "vitest";
import { mountChatView, settle, type MountedChatView } from "./support/mount-chat-view";

/** The tab header in the real ChatView (happy-dom: no layout, so every tab fits). */
let ui: MountedChatView;

afterEach(async () => {
  await ui?.close();
});

const labels = () => ui.$$('[data-ac="tab"] [data-ac="tab-label"]').map((el) => el.textContent);

function tabInput(): HTMLInputElement {
  const input = ui.$<HTMLInputElement>('[data-ac="tab-input"]');
  if (!input) throw new Error("no tab rename input");
  return input;
}

describe("tab strip", () => {
  it("shows numbers, marks the active tab, and caps the tab count at five", async () => {
    ui = await mountChatView();
    const add = ui.$<HTMLButtonElement>('[data-ac="tab-add"]');
    for (let count = 1; count < 7; count += 1) {
      add?.click();
      await settle();
    }
    expect(labels()).toEqual(["1", "2", "3", "4", "5"]);
    expect(add?.disabled).toBe(true);
    expect(ui.$$('[data-ac="tab"][aria-selected="true"]').map((el) => el.getAttribute("aria-label"))).toEqual(["Tab 5"]);
  });

  it("renames the current tab from the menu; Enter saves the label as the tab text", async () => {
    ui = await mountChatView();
    ui.$<HTMLButtonElement>('[data-ac="tab-overflow"]')?.click();
    await settle();
    expect(ui.$('[data-ac="tab-menu"]')?.style.display).not.toBe("none");
    ui.$$<HTMLButtonElement>('[data-ac="tab-menu"] .agentic-chat-menu-item')
      .find((item) => item.textContent === "Rename current tab")
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const input = tabInput();
    input.value = "Plan";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    expect(labels()).toEqual(["Plan"]);
  });

  it("Esc cancels a rename and keeps the number", async () => {
    ui = await mountChatView();
    ui.$('[data-ac="tab"]')?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = tabInput();
    input.value = "Nope";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(labels()).toEqual(["1"]);
  });
});
