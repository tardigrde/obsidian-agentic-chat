import { $, browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { expectNoHorizontalOverflow, expectWithinViewport } from "../../support/layout";
import { mark, writeMetrics } from "../../support/record";
import { openChat, sendPrompt } from "../support/probe-helpers";

/**
 * Deterministic layout probe: a long local command output must not overflow the
 * chat pane, and the composer must stay inside the viewport.
 */
describe("probe: layout smoke", function () {
  this.timeout(120_000);

  before(async function () {
    await openChat();
  });

  it("renders /help without horizontal overflow", async function () {
    await mark("chat open");

    await sendPrompt("/help");
    const info = await $(".agentic-chat-info");
    await info.waitForExist();
    await expect(info).toHaveText(/Slash commands/);
    await mark("help rendered");

    await expectNoHorizontalOverflow(".agentic-chat-view");
    await expectWithinViewport(".agentic-chat-input");

    const metrics = await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".agentic-chat-view");
      const input = document.querySelector<HTMLElement>(".agentic-chat-input");
      const viewRect = view?.getBoundingClientRect();
      const inputRect = input?.getBoundingClientRect();
      return {
        window: { width: window.innerWidth, height: window.innerHeight },
        view: viewRect
          ? { width: viewRect.width, height: viewRect.height, scrollWidth: view?.scrollWidth ?? 0 }
          : null,
        input: inputRect ? { top: inputRect.top, bottom: inputRect.bottom } : null,
      };
    });

    await writeMetrics(metrics);

    // Hold the final state so the recording does not end on a closing window.
    await browser.pause(1_200);
  });
});
