import { afterEach, describe, expect, it, vi } from "vitest";
import { mountChatView, settle, type MountedChatView } from "./support/mount-chat-view";
import { TabStrip, type TabView } from "../../src/ui/tab-strip";

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

describe("TabStrip re-render", () => {
  function strip() {
    const header = document.body.createDiv();
    const el = {
      header,
      strip: header.createDiv(),
      overflow: header.createEl("button"),
      menu: header.createDiv(),
      add: header.createEl("button"),
    };
    const activated: number[] = [];
    const tabStrip = new TabStrip(el, { activate: (i) => activated.push(i), close: () => {}, rename: () => {}, openHistory: () => {} });
    return { el, tabStrip, activated };
  }
  const views = (status: TabView["status"] = null): TabView[] => [
    { label: undefined, sessionName: undefined, status: null },
    { label: "Vendors", sessionName: undefined, status },
  ];

  it("keeps the tab nodes and focus when a background event re-renders the same state", () => {
    const { el, tabStrip } = strip();
    tabStrip.render(views("running"), 0, true, 5);
    const first = el.strip.querySelector<HTMLElement>('[data-ac="tab"]');
    first?.focus();
    tabStrip.render(views("running"), 0, true, 5);
    expect(el.strip.querySelector('[data-ac="tab"]')).toBe(first);
    expect(document.activeElement).toBe(first);
    tabStrip.dispose();
  });

  it("a rebuild during a touch long-press cancels it, so no rename opens after the finger lifts", () => {
    vi.useFakeTimers();
    try {
      const { el, tabStrip } = strip();
      tabStrip.render(views("running"), 0, true, 5);
      const tab = el.strip.querySelectorAll<HTMLElement>('[data-ac="tab"]')[1];
      const down = new MouseEvent("pointerdown", { bubbles: true, clientX: 5, clientY: 5 }) as MouseEvent & { pointerType: string };
      Object.defineProperty(down, "pointerType", { value: "touch" });
      tab?.dispatchEvent(down);
      tabStrip.render(views("unread"), 0, true, 5);
      vi.advanceTimersByTime(1_000);
      expect(el.strip.querySelector('[data-ac="tab-input"]')).toBeNull();
      tabStrip.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps keyboard focus on the same tab when a status change rebuilds the strip", () => {
    const { el, tabStrip } = strip();
    tabStrip.render(views("running"), 0, true, 5);
    el.strip.querySelectorAll<HTMLElement>('[data-ac="tab"]')[1]?.focus();
    tabStrip.render(views("unread"), 0, true, 5);
    const tabs = el.strip.querySelectorAll<HTMLElement>('[data-ac="tab"]');
    expect(tabs[1]?.getAttribute("data-ac-state")).toBe("unread");
    expect(document.activeElement).toBe(tabs[1]);
    tabStrip.dispose();
  });
});
