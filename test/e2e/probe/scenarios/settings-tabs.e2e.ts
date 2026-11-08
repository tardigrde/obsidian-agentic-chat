import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import { mark, writeMetrics } from "../../support/record";
import {
  closeAgenticChatSettings,
  openAgenticChatSettings,
  readSettingsTabLabels,
  selectSettingsTab,
  waitForSetting,
} from "../../support/settings-ui";

const ADVANCED_SECTIONS = [
  "web",
  "mcp",
  "observability",
  "notifications",
  "plugins",
  "subagents",
  "retrieval",
  "ignored-files",
];

const MOBILE_WIDTH = Number(process.env.AGENTIC_CHAT_PROBE_WIDTH || 390);
const MOBILE_HEIGHT = Number(process.env.AGENTIC_CHAT_PROBE_HEIGHT || 844);

/**
 * Records the three-tab settings cut: the default tab bar, the Agent tab, and
 * every Advanced section. Run it at 1280x1024 and 390x844 for entry-point clips.
 */
describe("probe: settings tabs", function () {
  this.timeout(120_000);

  it("shows three tabs and every Advanced section", async function () {
    await openAgenticChatSettings();
    // Fill the recorded display so the popout is not cropped on the narrow run.
    try {
      const screen = await browser.execute(() => ({ width: window.screen.width, height: window.screen.height }));
      await browser.setWindowRect(0, 0, screen.width, screen.height);
      await browser.execute(() => {
        window.moveTo(0, 0);
        window.resizeTo(window.screen.width, window.screen.height);
      });
    } catch {
      // A window manager may refuse the move or resize; the recording still shows the popout.
    }
    if (process.env.AGENTIC_CHAT_PROBE_MOBILE === "1") {
      const cdpBrowser = browser as typeof browser & {
        cdp?: (domain: string, command: string, args?: Record<string, unknown>) => Promise<unknown>;
      };
      await cdpBrowser.cdp?.("Emulation", "setDeviceMetricsOverride", {
        width: MOBILE_WIDTH,
        height: MOBILE_HEIGHT,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await browser.waitUntil(
        async () => (await browser.execute(() => window.innerWidth)) <= MOBILE_WIDTH + 80,
        { timeout: 5_000, timeoutMsg: "Settings window did not enter the narrow viewport" },
      );
    }

    await selectSettingsTab("Models");
    await waitForSetting("Model provider");
    expect(await readSettingsTabLabels()).toEqual(["Models", "Agent", "Advanced"]);
    await mark("three tabs");
    await browser.pause(1_200);

    await selectSettingsTab("Agent");
    await waitForSetting("Permission mode");
    await waitForSetting("Before mutating tools");
    await mark("agent tab");
    await browser.pause(1_200);

    await selectSettingsTab("Advanced");
    const sections = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-settings-section")).map(
        (section) => section.dataset.settingsSection,
      ),
    );
    expect(sections).toEqual(ADVANCED_SECTIONS);

    for (const section of ADVANCED_SECTIONS) {
      await browser.execute((sectionId) => {
        document
          .querySelector(`.agentic-chat-settings-section[data-settings-section="${sectionId}"]`)
          ?.scrollIntoView({ block: "start" });
      }, section);
      await mark(`advanced: ${section}`);
      await browser.pause(1_000);
    }

    const metrics = await browser.execute(() => {
      const tabs = document.querySelector<HTMLElement>(".setting-page-content");
      const body = document.querySelector<HTMLElement>(".agentic-chat-settings-tabbody");
      return {
        window: {
          width: window.innerWidth,
          height: window.innerHeight,
          screenX: window.screenX,
          screenY: window.screenY,
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
        },
        tabs: tabs
          ? { width: tabs.getBoundingClientRect().width, scrollWidth: tabs.scrollWidth }
          : null,
        body: body
          ? { width: body.getBoundingClientRect().width, scrollWidth: body.scrollWidth }
          : null,
      };
    });
    await writeMetrics(metrics);
    await browser.pause(800);
    await closeAgenticChatSettings();
  });
});
