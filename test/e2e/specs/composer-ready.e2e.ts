import { $, browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import { composerHitTest, waitForComposerReady } from "../support/layout";

/**
 * CI flake (2026-11-12, approval-deterministic): right after the chat opened in
 * the right sidebar, the composer "did not become interactable" for the whole
 * 5 s WebdriverIO retries a click (`waitforTimeout`). The failure screenshot
 * shows the sidebar caught mid-expand; the exact trigger did not reproduce
 * locally. Chromedriver reports "not interactable" for an element that is not
 * displayed, so this spec recreates that error on purpose: it hides the
 * composer for 7 s.
 */
async function hideComposer(ms: number): Promise<void> {
  await browser.execute((duration) => {
    const input = document.querySelector<HTMLElement>(".agentic-chat-input");
    if (!input) throw new Error("no composer");
    input.style.display = "none";
    window.setTimeout(() => {
      input.style.display = "";
    }, duration);
  }, ms);
}

describe("agentic-chat composer readiness", function () {
  it("waits for an unreachable composer before typing", async function () {
    await browser.executeObsidianCommand("agentic-chat:open-chat");
    await $(".agentic-chat-view").waitForExist();
    await waitForComposerReady();

    await hideComposer(7_000);
    // The recreated state: the composer cannot be clicked.
    expect((await composerHitTest()).hit).toBe(false);

    await waitForComposerReady();
    expect((await composerHitTest()).hit).toBe(true);
    const input = await $(".agentic-chat-input");
    await input.click();
    await input.setValue("composer is reachable");
    expect(await input.getValue()).toBe("composer is reachable");
    await input.setValue("");
  });
});
