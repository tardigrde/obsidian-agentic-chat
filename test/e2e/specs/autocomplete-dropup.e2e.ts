import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";

/**
 * Autocomplete dropup regression: the suggestion menu must render above the
 * input card, not clipped inside it. The card (`.agentic-chat-field`) uses
 * `overflow: hidden` for rounded-corner clipping, so a menu positioned inside
 * the card is cut off — with an empty chip row the whole menu sits above the
 * card's top edge and vanishes entirely. The menu therefore lives on the
 * composer and is measured against the card. No model calls here.
 */

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

async function typeQuery(value: string): Promise<void> {
  await browser.execute((text) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
    if (!textarea) throw new Error("agentic-chat composer is not mounted");
    textarea.focus();
    textarea.value = text;
    textarea.setSelectionRange(text.length, text.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

describe("autocomplete dropup", function () {
  before(async function () {
    await openChat();
  });

  it("renders the /sta menu above the input card, fully visible", async function () {
    await typeQuery("/sta");
    const menu = await $(".agentic-chat-autocomplete");
    await menu.waitForDisplayed({ timeout: 5_000 });

    const geometry = await browser.execute(() => {
      const menuEl = document.querySelector<HTMLElement>(".agentic-chat-autocomplete");
      const fieldEl = document.querySelector<HTMLElement>(".agentic-chat-field");
      if (!menuEl || !fieldEl) throw new Error("autocomplete menu or input card is missing");
      const menuRect = menuEl.getBoundingClientRect();
      const fieldRect = fieldEl.getBoundingClientRect();
      const rows = menuEl.querySelectorAll(".agentic-chat-autocomplete-item").length;
      // Point-hit test: the menu's center must hit the menu itself, not a
      // covering pane (messages list) — catches z-order regressions too.
      const hit = document.elementFromPoint(
        menuRect.left + menuRect.width / 2,
        menuRect.top + menuRect.height / 2,
      );
      return {
        rows,
        menuBottom: menuRect.bottom,
        menuHeight: menuRect.height,
        menuWidth: menuRect.width,
        fieldTop: fieldRect.top,
        hitInsideMenu: Boolean(hit && menuEl.contains(hit)),
      };
    });

    expect(geometry.rows).toBeGreaterThan(0);
    expect(geometry.menuHeight).toBeGreaterThan(0);
    expect(geometry.menuWidth).toBeGreaterThan(0);
    // Menu bottom sits just above the card top (8px gap), never overlapping it.
    expect(geometry.menuBottom).toBeLessThanOrEqual(geometry.fieldTop + 2);
    expect(geometry.hitInsideMenu).toBe(true);
  });
});
