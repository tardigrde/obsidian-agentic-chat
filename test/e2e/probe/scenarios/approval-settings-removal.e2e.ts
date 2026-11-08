import { browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { expectNoHorizontalOverflow } from "../../support/layout";
import { mark, writeMetrics } from "../../support/record";
import { configurePlugin, openChat } from "../support/probe-helpers";
import {
  closeAgenticChatSettings,
  openAgenticChatSettings,
  readAgenticChatSettings,
  readSettingsBodyText,
  selectSettingsTab,
  setSettingSelect,
  waitForSetting,
} from "../../support/settings-ui";

/**
 * Probe for #273: the Agent tab keeps the approval controls but no longer shows
 * the working-directory section. Records the desktop settings surface and saves
 * one control so the clip shows a live persistence path.
 */
describe("probe: approval settings after working-directory removal", function () {
  this.timeout(180_000);

  before(async function () {
    await configurePlugin({
      provider: "openrouter",
      openrouterApiKey: "e2e-scripted-key",
      mode: "safe",
      approval: { mutating: "ask", perTool: {} },
      web: { enabled: false },
    });
    await openChat();
  });

  after(async function () {
    try {
      await closeAgenticChatSettings();
    } catch {
      // Settings were already closed by the scenario.
    }
  });

  it("shows the remaining approval controls and no working-directory section", async function () {
    await mark("chat open");
    await openAgenticChatSettings();
    // Fill the recorded display so the popout is not cropped or hidden behind
    // the main window on a window-manager-less Xvfb display.
    try {
      const screen = await browser.execute(() => ({ width: window.screen.width, height: window.screen.height }));
      // Leave a margin: a window that exactly fills a WM-less Xvfb display can
      // record as a black frame even though the DOM is interactive.
      await browser.setWindowRect(24, 24, screen.width - 48, screen.height - 48);
      await browser.execute(() => {
        window.moveTo(24, 24);
        window.resizeTo(window.screen.width - 48, window.screen.height - 48);
      });
    } catch {
      // A window manager may refuse the move or resize; the recording still shows the popout.
    }
    await selectSettingsTab("Agent");
    await waitForSetting("Before mutating tools");
    await browser.execute(() => {
      const root = document.querySelector<HTMLElement>(".agentic-chat-settings-tabbody");
      const items = Array.from(root?.querySelectorAll<HTMLElement>(".setting-item") ?? []);
      const setting = items.find(
        (item) => item.querySelector<HTMLElement>(".setting-item-name")?.innerText.trim() === "Before mutating tools",
      );
      setting?.scrollIntoView({ block: "center" });
    });
    await mark("approval settings open");
    await browser.pause(1_200);

    const body = await readSettingsBodyText();
    expect(body).toContain("Before mutating tools");
    expect(body).toContain("Per-tool overrides");
    expect(body).not.toContain("Working directories");
    expect(body).not.toContain("Add folder");
    await mark("working-directory section absent");
    await browser.pause(1_400);

    await setSettingSelect("Before mutating tools", "deny");
    await browser.waitUntil(
      async () =>
        (await readAgenticChatSettings<{ approval: { mutating: string } }>()).approval.mutating === "deny",
      { timeout: 5_000, timeoutMsg: "the approval control did not persist" },
    );
    await mark("approval saved as deny");
    await browser.pause(1_200);

    await expectNoHorizontalOverflow(".agentic-chat-settings-tabbody");
    await writeMetrics({
      mode: "scripted",
      workingDirectorySectionPresent: body.includes("Working directories"),
      addFolderButtonPresent: body.includes("Add folder"),
      approvalControlsPresent: body.includes("Before mutating tools") && body.includes("Per-tool overrides"),
      savedMutating: "deny",
    });
  });
});
