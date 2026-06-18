import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";

/**
 * Base e2e smoke (D1): boots a real Obsidian on a throwaway copy of `test/e2e/vault`,
 * loads this plugin, and exercises the integration seams unit tests can't reach — view
 * registration, the composer card (C4), in-pane slash routing, the working-dir command
 * (C1), and active-note attachment. It deliberately avoids the model: every assertion
 * is on UI/wiring that runs without an API key. Local-only; not part of CI.
 */

/** Open the chat view and wait for it to mount. */
async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

/** Type a slash command and submit it through the explicit composer control.
 * Clicking avoids version-specific WebDriver key synthesis differences while
 * still exercising the same submit and slash-command route as Enter. */
async function runSlashCommand(command: string): Promise<void> {
  const input = await $(".agentic-chat-input");
  await input.click();
  await input.setValue(command);
  await $(".agentic-chat-send").click();
}

describe("agentic-chat smoke", function () {
  before(async function () {
    await openChat();
  });

  it("renders the unified composer card with a tab and textarea", async function () {
    await expect($(".agentic-chat-field")).toExist();
    await expect($(".agentic-chat-tabs .agentic-chat-tab")).toExist();
    await expect($(".agentic-chat-input")).toExist();
  });

  it("runs an in-pane slash command (/help) without calling the model", async function () {
    await runSlashCommand("/help");
    const info = await $(".agentic-chat-info");
    await info.waitForExist();
    await expect(info).toHaveText(/Slash commands/);
  });

  it("lists working directories via /dirs (C1)", async function () {
    await runSlashCommand("/dirs");
    const list = await $(".agentic-chat-action-list");
    await list.waitForExist();
    await expect(list).toHaveText(/Add working directory/);
  });

  it("auto-attaches the active note as a context chip", async function () {
    await browser.executeObsidian(async ({ app, obsidian }) => {
      const existing = app.vault.getAbstractFileByPath("Welcome.md");
      const file = existing instanceof obsidian.TFile ? existing : await app.vault.create("Welcome.md", "# Welcome\n");
      await app.workspace.getLeaf(false).openFile(file);
    });
    const chip = await $(".agentic-chat-chip.is-active-note");
    await chip.waitForExist();
    await expect(chip).toHaveText(/Welcome/);
  });
});
