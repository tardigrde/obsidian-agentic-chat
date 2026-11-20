import { mkdirSync } from "node:fs";
import { browser, expect, $ } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { configureScriptedPlugin, openChat, submitComposer, waitForIdle, waitForTranscript } from "../support/chat";
import { clearScriptedTurns, installScriptedTurns, releaseScriptedTurns, scriptedCallCount, textTurn } from "../support/scripted-stream";

/**
 * U3 #12: the Queue control while a turn runs, in the real app. The owner saw
 * no queued chip and no queued send; an empty draft gave no hint at all.
 */

async function userBubbles(): Promise<string[]> {
  return await browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-user")).map((el) => el.innerText.trim()),
  );
}

describe("composer queue", () => {
  before(async () => {
    // The scripted stream is picked when the view creates its service.
    await installScriptedTurns([
      textTurn("held", "Held answer.", { hold: true }),
      textTurn("queued", "Queued answer."),
    ]);
    await configureScriptedPlugin();
    await openChat();
  });

  after(async () => {
    await releaseScriptedTurns();
    await clearScriptedTurns();
  });

  it("Queue is disabled with an empty draft, shows a visible chip, and sends the draft after the turn", async () => {
    await submitComposer("first held prompt");
    await $('[data-ac="stop"]').waitForDisplayed({ timeout: 5_000 });

    const send = await $('[data-ac="send"]');
    await browser.waitUntil(async () => (await send.getAttribute("data-ac-state")) === "queue", {
      timeout: 5_000,
      timeoutMsg: "the send control never turned into Queue while the turn ran",
    });
    // An empty draft has nothing to queue: the control says so and does nothing.
    expect(await send.isEnabled()).toBe(false);
    expect(await send.getAttribute("aria-label")).toMatch(/queue/i);
    // One screenshot for the PR (logs/ is git-ignored): Queue disabled on an empty draft.
    mkdirSync("logs/pr-u3a-shots", { recursive: true });
    await browser.saveScreenshot("logs/pr-u3a-shots/u3a-queue-empty.png");

    // Type like a user, then press Queue.
    const input = await $('[data-ac="composer-input"]');
    await input.click();
    await input.setValue("follow-up queued prompt");
    expect(await send.isEnabled()).toBe(true);
    await send.click();

    const chip = await $(".agentic-chat-chip.is-pending");
    await chip.waitForDisplayed({ timeout: 3_000, timeoutMsg: "the queued chip never became visible" });
    expect(await chip.getText()).toContain("follow-up queued prompt");

    await releaseScriptedTurns();
    await waitForTranscript("Queued answer.", 10_000);
    await waitForIdle();
    expect(await scriptedCallCount()).toBe(2);
    const bubbles = await userBubbles();
    expect(bubbles).toHaveLength(2);
    expect(bubbles[1]).toContain("follow-up queued prompt");
    expect(await $(".agentic-chat-chip.is-pending").isExisting()).toBe(false);
  });
});
