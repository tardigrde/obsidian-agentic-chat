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
    const renamed: Array<[number, string | undefined]> = [];
    const tabStrip = new TabStrip(el, {
      activate: (i) => activated.push(i),
      close: () => {},
      rename: (i, label) => renamed.push([i, label]),
      openHistory: () => {},
    });
    return { el, tabStrip, activated, renamed };
  }
  const views = (status: TabView["status"] = null): TabView[] => [
    { key: "a", label: undefined, sessionName: undefined, status: null },
    { key: "b", label: "Vendors", sessionName: undefined, status },
  ];

  it("hidden tabs go into +N, and its dot shows the most urgent hidden status", () => {
    // happy-dom has no layout: give each tab 100px in a 160px strip.
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 100 } as DOMRect);
    try {
      const { el, tabStrip } = strip();
      Object.defineProperty(el.strip, "clientWidth", { value: 160 });
      tabStrip.render(
        [
          { key: "a", label: undefined, sessionName: undefined, status: null },
          { key: "b", label: undefined, sessionName: undefined, status: "running" },
          { key: "c", label: undefined, sessionName: undefined, status: "needs-you" },
        ],
        0,
        true,
        5,
      );
      expect(el.overflow.textContent).toBe("+2");
      expect(el.overflow.getAttribute("data-ac-state")).toBe("needs-you");
      expect(el.overflow.querySelector(".agentic-chat-dot.is-needs-you")).not.toBeNull();
      expect(el.overflow.getAttribute("aria-label")).toBe("2 more tabs, needs approval");
      tabStrip.dispose();
    } finally {
      rect.mockRestore();
    }
  });

  it("Left, Right, Home, and End move and activate, wrapping at the ends", () => {
    const { el, tabStrip, activated } = strip();
    const three: TabView[] = [...views(), { key: "c", label: undefined, sessionName: undefined, status: null }];
    tabStrip.render(three, 0, true, 5);
    const press = (index: number, key: string) =>
      el.strip.querySelectorAll<HTMLElement>('[data-ac="tab"]')[index]?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    press(0, "ArrowRight");
    press(0, "ArrowLeft");
    press(1, "End");
    press(2, "Home");
    press(2, "ArrowRight");
    expect(activated).toEqual([1, 2, 2, 0, 0]);
    // Roving tabindex: only the active tab is in the Tab order.
    expect(Array.from(el.strip.querySelectorAll('[data-ac="tab"]')).map((tab) => tab.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    tabStrip.dispose();
  });

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
      // A second finger on the same tab must not leave an orphan timer.
      const second = new MouseEvent("pointerdown", { bubbles: true, clientX: 6, clientY: 6 }) as MouseEvent & { pointerType: string };
      Object.defineProperty(second, "pointerType", { value: "touch" });
      tab?.dispatchEvent(second);
      tabStrip.render(views("unread"), 0, true, 5);
      vi.advanceTimersByTime(1_000);
      expect(el.strip.querySelector('[data-ac="tab-input"]')).toBeNull();
      tabStrip.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a rename follows its tab when an earlier tab closes, and the strip does not freeze", () => {
    const { el, tabStrip, renamed } = strip();
    tabStrip.render(views(), 1, true, 5);
    el.strip.querySelectorAll<HTMLElement>('[data-ac="tab"]')[1]?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const input = el.strip.querySelector<HTMLInputElement>('[data-ac="tab-input"]');
    expect(input).not.toBeNull();
    if (input) input.value = "Plan";
    // Tab "a" closes while the rename is open: "b" is now index 0.
    tabStrip.render([views()[1]], 0, true, 5);
    expect(renamed).toEqual([[0, "Plan"]]);
    expect(el.strip.querySelector('[data-ac="tab"][aria-selected="true"] [data-ac="tab-label"]')?.textContent).toBe("Vendors");
    tabStrip.dispose();
  });

  it("a background status change does not end a rename the user is typing", () => {
    const { el, tabStrip, renamed } = strip();
    tabStrip.render(views(), 0, true, 5);
    el.strip.querySelectorAll<HTMLElement>('[data-ac="tab"]')[0]?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    tabStrip.render(views("running"), 0, true, 5);
    expect(el.strip.querySelector('[data-ac="tab-input"]')).not.toBeNull();
    expect(renamed).toEqual([]);
    tabStrip.dispose();
  });

  it("Delete closes the focused tab from the keyboard (when more than one is open)", () => {
    const closed: number[] = [];
    const header = document.body.createDiv();
    const el = { header, strip: header.createDiv(), overflow: header.createEl("button"), menu: header.createDiv(), add: header.createEl("button") };
    const tabStrip = new TabStrip(el, { activate: () => {}, close: (i) => closed.push(i), rename: () => {}, openHistory: () => {} });
    tabStrip.render(views(), 0, true, 5);
    const second = el.strip.querySelectorAll<HTMLElement>('[data-ac="tab"]')[1];
    expect(second?.getAttribute("aria-keyshortcuts")).toBe("Delete");
    second?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(closed).toEqual([1]);
    tabStrip.render([views()[0]], 0, true, 5);
    el.strip.querySelector<HTMLElement>('[data-ac="tab"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(closed).toEqual([1]);
    tabStrip.dispose();
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
