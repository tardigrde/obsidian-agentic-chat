import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";

/**
 * Skill invocation signal: `/skill <name>` used to inject silently — the
 * transcript jumped straight to the first thought/tool step with no trace of
 * which skill loaded. The view now renders a "Skill" info block first. The
 * follow-up model turn needs no API key for this assertion: the chip renders
 * before the turn starts, so we only wait for the chip itself.
 */

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

describe("skill invocation chip", function () {
  before(async function () {
    await openChat();
  });

  it("renders a Skill block naming the loaded skill", async function () {
    await browser.execute(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
      const send = document.querySelector<HTMLButtonElement>(".agentic-chat-send");
      if (!textarea || !send) throw new Error("agentic-chat composer is not mounted");
      textarea.value = "/skill self-knowledge e2e chip probe";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      send.click();
    });

    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const infos = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-info"));
          return infos.some((el) => {
            const title = el.querySelector("summary")?.innerText.trim() ?? "";
            return title === "Skill" && (el.innerText ?? "").includes("self-knowledge");
          });
        }),
      { timeout: 10_000, timeoutMsg: "Skill loaded chip did not render for /skill self-knowledge" },
    );

    const text = await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "");
    expect(text).toContain("self-knowledge");
  });
});
