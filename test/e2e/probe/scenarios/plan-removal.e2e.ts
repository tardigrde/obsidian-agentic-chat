import { $, browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { expectNoHorizontalOverflow, expectWithinViewport } from "../../support/layout";
import { mark, writeMetrics } from "../../support/record";
import {
  configurePlugin,
  installScriptedTurns,
  openChat,
  renderedAssistantText,
  sendPrompt,
  waitForScriptedCalls,
} from "../support/probe-helpers";

/**
 * Probe the removed plan entrypoints: /help has no /plan, the composer has no
 * Plan badge, and typing /plan falls through as a normal model prompt while the
 * mode stays Safe.
 */
describe("probe: plan mode removal", function () {
  this.timeout(120_000);

  before(async function () {
    await installScriptedTurns([
      { label: "plan-shaped prompt", stopReason: "stop", content: [{ type: "text", text: "Plain chat answer without plan mode." }] },
    ]);
    await configurePlugin({
      provider: "openrouter",
      openrouterApiKey: "e2e-scripted-key",
      mode: "safe",
      approval: { mutating: "ask", perTool: {}, workingDirs: [] },
      web: { enabled: false },
    });
    await openChat();
  });

  it("shows no plan entrypoint and treats /plan as a normal prompt", async function () {
    await mark("chat open - no Plan badge");
    await expect($(".agentic-chat-plan-badge")).not.toExist();
    await expect($(".agentic-chat-mode-toggle")).toBeDisplayed();

    await sendPrompt("/help");
    const info = await $(".agentic-chat-info");
    await info.waitForExist();
    await expect(info).toHaveText(/Slash commands/);
    await expect(info).not.toHaveText(/\/plan\b/);
    await mark("help has no /plan");
    await expectNoHorizontalOverflow(".agentic-chat-view");
    await expectWithinViewport(".agentic-chat-input");

    await sendPrompt("/plan outline the vault cleanup");
    await waitForScriptedCalls(1);
    await browser.waitUntil(
      async () => (await renderedAssistantText()).includes("Plain chat answer without plan mode."),
      { timeout: 15_000, timeoutMsg: "the scripted normal chat answer did not render" },
    );
    await mark("/plan answered as a normal chat prompt");

    const metrics = await browser.executeObsidian(async ({ app }) => {
      const plugin = (app as unknown as { plugins?: { plugins?: Record<string, { settings?: { mode?: string } }> } })
        .plugins?.plugins?.["agentic-chat"];
      const view = document.querySelector<HTMLElement>(".agentic-chat-view");
      return {
        mode: plugin?.settings?.mode ?? "",
        planBadge: document.querySelectorAll(".agentic-chat-plan-badge").length,
        planToggleClass: document.querySelectorAll(".agentic-chat-mode-toggle.is-planning").length,
        viewWidth: view?.getBoundingClientRect().width ?? 0,
        windowWidth: window.innerWidth,
      };
    });
    await writeMetrics(metrics);
    expect(metrics.mode).toBe("safe");
    expect(metrics.planBadge).toBe(0);
    expect(metrics.planToggleClass).toBe(0);
    expect(metrics.viewWidth).toBeLessThanOrEqual(metrics.windowWidth);

    await mark("final state: Safe mode, no plan badge");
    await browser.pause(1_200);
  });
});
