import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";
import {
  configureLivePlugin,
  readLatestSessionRaw,
  sendPrompt,
  TURN_TIMEOUT_MS,
  waitForTurnEnd,
} from "./dogfood-helpers";

describe("agentic-chat B9+B11 live dogfood", function () {
  const apiKey = process.env.AGENTIC_CHAT_API_KEY?.trim();
  const baseUrl = process.env.AGENTIC_CHAT_BASE_URL?.trim() || "https://openrouter.ai/api/v1";
  const model = process.env.AGENTIC_CHAT_MODEL?.trim() || "openrouter/auto";

  before(async function () {
    if (process.env.AGENTIC_CHAT_B9B11_DOGFOOD !== "true") this.skip();
    if (!apiKey) this.skip();

    await configureLivePlugin({ apiKey, baseUrl, model });

    await browser.executeObsidian(async ({ app }) => {
      const notePath = "B9-B11 Dogfood.md";
      const file = app.vault.getAbstractFileByPath(notePath);
      if (file) await app.vault.delete(file);
      await app.vault.create(
        notePath,
        [
          "# B9-B11 Dogfood Test Note",
          "This note is used to verify read caching and context compression.",
          "Line 3: Apple Banana Cherry",
          "Line 4: Delta Echo Foxtrot",
          "Line 5: Golf Hotel India",
          "Line 6: Juliet Kilo Lima",
          "Line 7: Mike November Oscar",
          "Line 8: Papa Quebec Romeo",
          "Line 9: Sierra Tango Uniform",
          "Line 10: Victor Whiskey X-ray",
          "Line 11: Yankee Zulu Alpha",
          "Line 12: Bravo Charlie Delta",
        ].join("\n"),
      );
    });

    await browser.executeObsidianCommand("agentic-chat:open-chat");
    await $(".agentic-chat-view").waitForExist();
  });

  it("compresses unchanged context across turns (B11)", async function () {
    // Open the test note in a new leaf so it becomes the active file.
    await browser.executeObsidian(async ({ app, obsidian }) => {
      const file = app.vault.getAbstractFileByPath("B9-B11 Dogfood.md");
      if (!(file instanceof obsidian.TFile)) throw new Error("B9-B11 Dogfood.md not found");
      await app.workspace.getLeaf(false).openFile(file);
    });

    // Wait for the active-note chip to appear in the chat view.
    await browser.waitUntil(
      async () => await $(".agentic-chat-chip.is-active-note").isExisting(),
      { timeout: 5_000, timeoutMsg: "active-note chip did not appear" },
    );

    // Turn 1: ask about the note.
    await sendPrompt("What is the first word on line 3 of B9-B11 Dogfood.md?");
    await waitForTurnEnd(TURN_TIMEOUT_MS);

    // Turn 2: ask another question while the same note is active.
    // The active note cache should already say "unchanged" on turn 2.
    // On turn 3, the PromptContextCache should compress the whole context block.
    await sendPrompt("What is the last word on line 10?");
    await waitForTurnEnd(TURN_TIMEOUT_MS);

    // Turn 3: same note still active — full context block should compress.
    await sendPrompt("What is the first word on line 12?");
    await waitForTurnEnd(TURN_TIMEOUT_MS);

    const raw = await readLatestSessionRaw();
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).toContain("context unchanged since previous turn");
  });

  it("includes a diff summary after an edit (B9)", async function () {
    // Open the test note in a new leaf.
    await browser.executeObsidian(async ({ app, obsidian }) => {
      const file = app.vault.getAbstractFileByPath("B9-B11 Dogfood.md");
      if (!(file instanceof obsidian.TFile)) throw new Error("B9-B11 Dogfood.md not found");
      await app.workspace.getLeaf(false).openFile(file);
    });

    // Ask the model to edit line 3.
    await sendPrompt(
      'Use the edit tool on B9-B11 Dogfood.md to change "Apple Banana Cherry" to "Apple Banana Pear".',
    );
    await waitForTurnEnd(TURN_TIMEOUT_MS);

    const raw = await readLatestSessionRaw();
    expect(raw.length).toBeGreaterThan(0);
    expect(raw).toContain("Diff summary");
  });
});
