import { $, browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import { mark } from "../../support/record";
import {
  closeAgenticChatSettings,
  openAgenticChatSettings,
  selectSettingsTab,
  waitForSetting,
} from "../../support/settings-ui";

/**
 * Disposable probe: show the overwrite confirm while creating a skill whose
 * package already exists. Used for the issue #259 UI evidence clip.
 */
describe("probe: overwrite confirm", function () {
  this.timeout(180_000);

  it("shows the overwrite confirm modal", async function () {
    const seeded = await browser.executeObsidian(async ({ app }) => {
      const plugin = (
        app as unknown as {
          plugins?: {
            plugins?: Record<
              string,
              { pluginService?: { scaffoldSkill: (input: unknown, options: unknown) => Promise<unknown> } }
            >;
          };
        }
      ).plugins?.plugins?.["agentic-chat"];
      if (!plugin?.pluginService) return false;
      await plugin.pluginService.scaffoldSkill(
        { name: "demo-skill", description: "demo", body: "# Demo\n\nProbe fixture." },
        { allowOverwrite: true },
      );
      return true;
    });
    expect(seeded).toBe(true);

    await openAgenticChatSettings();
    await selectSettingsTab("Advanced");
    await waitForSetting("Import", "plugins");

    await browser.execute(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".setting-item button"));
      buttons.find((button) => button.textContent?.trim() === "New skill…")?.click();
    });

    const nameInput = await $('input[placeholder="e.g. release-notes"]');
    await nameInput.waitForExist();
    await mark("new skill form open");
    await nameInput.setValue("demo-skill");
    await browser.pause(400);

    await browser.execute(() => {
      const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".modal button"));
      buttons.find((button) => button.textContent?.trim() === "Create skill")?.click();
    });

    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          Array.from(document.querySelectorAll<HTMLElement>(".modal")).some((modal) =>
            modal.textContent?.includes("Replace existing skill package?"),
          ),
        ),
      { timeout: 10_000, timeoutMsg: "overwrite confirm modal did not open" },
    );
    await mark("overwrite confirm modal");
    await browser.pause(1_500);

    const buttons = await browser.execute(() => {
      const confirmModal = Array.from(document.querySelectorAll<HTMLElement>(".modal")).find((modal) =>
        modal.textContent?.includes("Replace existing skill package?"),
      );
      return Array.from(confirmModal?.querySelectorAll<HTMLButtonElement>("button") ?? []).map((button) =>
        button.textContent?.trim(),
      );
    });
    expect(buttons).toContain("Replace");
    expect(buttons).toContain("Cancel");

    await browser.execute(() => {
      const confirmModal = Array.from(document.querySelectorAll<HTMLElement>(".modal")).find((modal) =>
        modal.textContent?.includes("Replace existing skill package?"),
      );
      const buttons = Array.from(confirmModal?.querySelectorAll<HTMLButtonElement>("button") ?? []);
      buttons.find((button) => button.textContent?.trim() === "Replace")?.click();
    });
    await browser.pause(800);
    await closeAgenticChatSettings();
  });
});
