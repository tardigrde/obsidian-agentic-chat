import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { configureScriptedPlugin, openChat, submitComposer, waitForIdle, waitForTranscript } from "../support/chat";
import { clearScriptedTurns, installScriptedTurns, textTurn } from "../support/scripted-stream";

/**
 * Tabs v2 in real Obsidian: the header row, number-or-label tabs, rename by
 * double-click (desktop), long-press (touch), and the tab menu, a label that
 * survives a plugin reload without changing the session name, and the `+N`
 * overflow with five tabs in a narrow pane.
 */

const VIEW = "agentic-chat-chat-view";

/** WebDriver sends `undefined` back as `null`, so missing fields are `null` here. */
interface TabInfo {
  name: string | null;
  tabLabel: string | null;
}

async function tabInfos(): Promise<TabInfo[]> {
  return await browser.executeObsidian(({ app }, viewType) => {
    const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
      chatTabs?: { allTabs(): Array<{ service: { getSessionInfo(): { name?: string; tabLabel?: string } | undefined } }> };
    };
    return (view?.chatTabs?.allTabs() ?? []).map((tab) => {
      const info = tab.service.getSessionInfo();
      return { name: info?.name ?? null, tabLabel: info?.tabLabel ?? null };
    });
  }, VIEW);
}

async function tabLabels(): Promise<string[]> {
  return await browser.execute(() =>
    Array.from(document.querySelectorAll('[data-ac="tab"] [data-ac="tab-label"]')).map((el) => el.textContent ?? ""),
  );
}

async function waitForTabLabel(index: number, text: string): Promise<void> {
  await browser.waitUntil(async () => (await tabLabels())[index] === text, {
    timeout: 5_000,
    timeoutMsg: `tab ${index + 1} never showed ${JSON.stringify(text)} (got ${JSON.stringify(await tabLabels())})`,
  });
}

async function tabCount(): Promise<number> {
  return await browser.execute(() => document.querySelectorAll('[data-ac="tab"]').length);
}

async function setLabelThroughService(index: number, label: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, viewType, tabIndex, value) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
        chatTabs: { renameTab(index: number, label: string | undefined): Promise<void> };
      };
      await view.chatTabs.renameTab(tabIndex, value);
    },
    VIEW,
    index,
    label,
  );
}

describe("tabs v2", function () {
  before(async function () {
    await installScriptedTurns([textTurn("first", "Here is the first answer.")]);
    await configureScriptedPlugin("allow");
    await openChat();
  });

  after(async function () {
    await clearScriptedTurns();
  });

  it("puts the tabs in a header row above the transcript", async function () {
    const order = await browser.execute(() => {
      const view = document.querySelector('[data-ac="view"]');
      return Array.from(view?.children ?? []).map((el) => el.getAttribute("data-ac") ?? el.className);
    });
    expect(order.slice(0, 3)).toEqual(["header", "messages", "composer"]);
    await expect($('[data-ac="header"] [data-ac="tab-strip"][role="tablist"]')).toExist();
    expect(await tabLabels()).toEqual(["1"]);
  });

  it("renames a tab by double-click; the label survives a reload and the session name does not change", async function () {
    await submitComposer("Plan the vendor review for next week");
    await waitForTranscript("Here is the first answer.");
    await waitForIdle();
    const before = (await tabInfos())[0];
    expect(before.name).toBeTruthy();
    expect(before.tabLabel).toBeNull();

    await $('[data-ac="tab"]').doubleClick();
    const input = await $('[data-ac="tab-input"]');
    await input.waitForExist({ timeout: 3_000 });
    // The input selects its text; type over it. (WebDriver's clear blurs the
    // input, and blur commits the rename.)
    await browser.keys("Plan");
    await browser.keys("Enter");
    await waitForTabLabel(0, "Plan");
    expect(await $('[data-ac="tab"]').getAttribute("aria-label")).toBe("Tab 1, Plan");
    expect((await tabInfos())[0]).toEqual({ name: before.name, tabLabel: "Plan" });

    await browser.executeObsidian(async ({ app }) => {
      const plugins = (app as unknown as { plugins: { disablePlugin(id: string): Promise<void>; enablePlugin(id: string): Promise<void> } }).plugins;
      await plugins.disablePlugin("agentic-chat");
      await plugins.enablePlugin("agentic-chat");
    });
    await openChat();
    await waitForTabLabel(0, "Plan");
    expect((await tabInfos())[0]).toEqual({ name: before.name, tabLabel: "Plan" });
  });

  it("clears a label with an empty name, so the tab shows its number again", async function () {
    await $('[data-ac="tab"]').doubleClick();
    const input = await $('[data-ac="tab-input"]');
    await input.waitForExist({ timeout: 3_000 });
    await browser.keys(["Backspace", "Enter"]);
    await waitForTabLabel(0, "1");
    expect((await tabInfos())[0].tabLabel).toBeNull();
  });

  it("holds five tabs; in a 360px pane the rest go into the +N menu", async function () {
    for (let count = await tabCount(); count < 5; count += 1) {
      await $('[data-ac="tab-add"]').click();
      await browser.waitUntil(async () => (await tabCount()) === count + 1, { timeout: 5_000 });
    }
    expect(await $('[data-ac="tab-add"]').getAttribute("disabled")).not.toBeNull();
    for (const [index, label] of ["Reading list", "Weekly review", "Vendor shortlist", "Daily notes", "Errands"].entries()) {
      await setLabelThroughService(index, label);
    }
    await waitForTabLabel(4, "Errands");

    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-ac="view"]')?.style.setProperty("width", "360px");
    });
    await browser.waitUntil(async () => (await $('[data-ac="tab-overflow"]').getText()).startsWith("+"), {
      timeout: 5_000,
      timeoutMsg: "no +N overflow at 360px",
    });
    const state = await browser.execute(() => {
      const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-ac="tab"]'));
      const hidden = tabs.filter((tab) => tab.classList.contains("is-overflow")).length;
      const active = tabs.findIndex((tab) => tab.classList.contains("is-active"));
      const strip = document.querySelector<HTMLElement>('[data-ac="tab-strip"]')?.getBoundingClientRect();
      const lastVisible = tabs.filter((tab) => !tab.classList.contains("is-overflow")).at(-1)?.getBoundingClientRect();
      return { hidden, active, activeVisible: !tabs[active]?.classList.contains("is-overflow"), fits: !!strip && !!lastVisible && lastVisible.right <= strip.right + 1 };
    });
    expect(state.hidden).toBeGreaterThan(0);
    expect(state.activeVisible).toBe(true);
    expect(state.fits).toBe(true);
    expect(await $('[data-ac="tab-overflow"]').getText()).toContain(`+${state.hidden}`);

    await $('[data-ac="tab-overflow"]').click();
    const menu = await $('[data-ac="tab-menu"]');
    await menu.waitForDisplayed({ timeout: 3_000 });
    const items = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-ac="tab-menu"] .agentic-chat-menu-item')).map((el) => el.textContent ?? ""),
    );
    expect(items.filter((text) => /^\d/.test(text))).toHaveLength(state.hidden);
    expect(items).toEqual(expect.arrayContaining(["Rename current tab", "Open from history…", "Close current tab"]));

    // Picking a hidden tab activates it, and it moves into view.
    const hiddenIndex = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-ac="tab"]')).findIndex((tab) => tab.classList.contains("is-overflow")),
    );
    await browser.execute(() => document.querySelector<HTMLElement>('[data-ac="tab-menu"] .agentic-chat-menu-item')?.click());
    await browser.waitUntil(
      async () =>
        await browser.execute((index) => {
          const tab = document.querySelectorAll('[data-ac="tab"]')[index];
          return !!tab?.classList.contains("is-active") && !tab.classList.contains("is-overflow");
        }, hiddenIndex),
      { timeout: 5_000, timeoutMsg: "the hidden tab did not become the active, visible tab" },
    );
  });

  it("renames the current tab from the menu; Esc cancels", async function () {
    const active = await browser.execute(() =>
      Array.from(document.querySelectorAll('[data-ac="tab"]')).findIndex((tab) => tab.classList.contains("is-active")),
    );
    const label = (await tabLabels())[active];
    await $('[data-ac="tab-overflow"]').click();
    await $('[data-ac="tab-menu"]').waitForDisplayed({ timeout: 3_000 });
    await browser.execute(() => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('[data-ac="tab-menu"] .agentic-chat-menu-item'));
      items.find((item) => item.textContent === "Rename current tab")?.click();
    });
    const input = await $('[data-ac="tab-input"]');
    await input.waitForExist({ timeout: 3_000 });
    await browser.keys("Something else");
    await browser.keys("Escape");
    await waitForTabLabel(active, label);
  });

  it("keyboard focus on a tab shows its ring inside the strip, not clipped", async function () {
    await $('[data-ac="tab"][aria-selected="true"]').click();
    await browser.keys("ArrowLeft");
    const ring = await browser.execute(() => {
      const el = document.activeElement as HTMLElement | null;
      const strip = el?.closest('[data-ac="tab-strip"]');
      if (!el || !strip) return null;
      const style = getComputedStyle(el);
      const tab = el.getBoundingClientRect();
      const box = strip.getBoundingClientRect();
      const reach = Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth);
      return {
        visible: el.matches(":focus-visible"),
        style: style.outlineStyle,
        inside: tab.top - reach >= box.top - 0.5 && tab.bottom + reach <= box.bottom + 0.5,
      };
    });
    expect(ring).toEqual({ visible: true, style: "solid", inside: true });
  });

  it("long-press renames on touch, and the close button is only in the menu there", async function () {
    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-ac="view"]')?.parentElement?.classList.add("is-mobile");
      const tab = document.querySelector<HTMLElement>('[data-ac="tab"].is-active');
      tab?.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, clientX: 10, clientY: 10 }));
    });
    const input = await $('[data-ac="tab-input"]');
    await input.waitForExist({ timeout: 2_000 });
    await browser.keys("Escape");
    const closeShown = await browser.execute(() => {
      const tab = document.querySelector<HTMLElement>('[data-ac="tab"].is-active');
      const close = tab?.querySelector<HTMLElement>('[data-ac="tab-close"]');
      tab?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      return close ? getComputedStyle(close).display : "missing";
    });
    expect(closeShown).toBe("none");
    await browser.execute(() => {
      document.querySelector<HTMLElement>('[data-ac="view"]')?.parentElement?.classList.remove("is-mobile");
      document.querySelector<HTMLElement>('[data-ac="view"]')?.style.removeProperty("width");
    });
  });
});
