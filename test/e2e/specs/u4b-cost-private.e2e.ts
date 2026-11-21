import { mkdirSync } from "node:fs";
import { browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { configureScriptedPlugin, openChat, submitComposer, VIEW_TYPE_AGENT_CHAT, waitForIdle, waitForTranscript } from "../support/chat";
import { expectNoOverlap, expectWithinWindow } from "../support/layout";
import { clearScriptedTurns, installScriptedTurns, releaseScriptedTurns, textTurn, type ScriptedTurn } from "../support/scripted-stream";

/**
 * U4-B in real Obsidian: the session total in the composer bar (subagents
 * included, U4 #8) and the private active-note chip (U4 #11).
 */

const FOLDER = "U4B";
const NOTE = `${FOLDER}/Note.md`;
const PRIVATE_NOTE = `${FOLDER}/Private/Diary.md`;
const SHOTS = "logs/pr-u4b-shots";

const paid = (cost: number) => ({ usage: { input: 10, output: 10, totalTokens: 20, cost: { total: cost } } });

function turn(label: string, content: ScriptedTurn["content"], options: Partial<ScriptedTurn> = {}): ScriptedTurn {
  const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
  return { label, stopReason, content, ...options } as ScriptedTurn;
}

describe("U4-B composer bar: session cost and private chip", function () {
  before(async function () {
    await browser.executeObsidian(async ({ app }, { folder, note, privateNote }) => {
      for (const path of [folder, `${folder}/Private`]) if (!app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
      if (!app.vault.getAbstractFileByPath(note)) await app.vault.create(note, "# Note\n\nshort note");
      if (!app.vault.getAbstractFileByPath(privateNote)) await app.vault.create(privateNote, "# Diary\n\nDIARY-BODY");
    }, { folder: FOLDER, note: NOTE, privateNote: PRIVATE_NOTE });
    await installScriptedTurns([]);
    await configureScriptedPlugin("allow");
    await openChat();
  });

  after(async function () {
    await releaseScriptedTurns();
    await clearScriptedTurns();
    await browser.executeObsidian(async ({ app, obsidian }, folder) => {
      const entry = app.vault.getAbstractFileByPath(folder);
      if (entry instanceof obsidian.TFolder) await app.vault.trash(entry, true);
    }, FOLDER);
  });

  it("U4 #8: the composer bar shows the session total, subagents included", async function () {
    await installScriptedTurns([
      turn("dispatch", [{ type: "toolCall", id: "u4b-sub", name: "subagent", arguments: { agent: "explorer", task: "read the note" } }], paid(0.001)),
      turn("child-read", [{ type: "toolCall", id: "u4b-r1", name: "read", arguments: { path: NOTE } }], paid(0.002)),
      textTurn("child-report", "CHILD-REPORT the note is short.", paid(0.002)),
      textTurn("parent-end", "COST-END done.", paid(0.001)),
    ]);
    await submitComposer("delegate and count");
    await waitForTranscript("COST-END done.");
    await waitForIdle();
    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelector('[data-ac="session-cost"]')?.textContent)) === "$0.0060",
      { timeout: 5_000, timeoutMsg: "the composer bar never showed the session total $0.0060" },
    );
    await expectWithinWindow(['[data-ac="session-cost"]']);
    await expectNoOverlap('[data-ac="session-cost"]', '[data-ac="model-pill"]');
  });

  it("U4 #11: a private active note shows a lock chip and is never sent", async function () {
    await browser.executeObsidian(async ({ app, obsidian }, { privateNote, viewType }) => {
      const plugin = (app as unknown as { plugins: { plugins: Record<string, { settings: { ignoredGlobs: string }; saveSettings: () => Promise<void> }> } }).plugins.plugins["agentic-chat"];
      plugin.settings.ignoredGlobs = "U4B/Private/, #private";
      await plugin.saveSettings();
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as { service: { reloadRuntimeResources: () => Promise<unknown> } };
      await view.service.reloadRuntimeResources();
      const file = app.vault.getAbstractFileByPath(privateNote);
      if (!(file instanceof obsidian.TFile)) throw new Error("missing private note");
      // As a user opens a note: the file in a tab, and that tab active.
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
    }, { privateNote: PRIVATE_NOTE, viewType: VIEW_TYPE_AGENT_CHAT });
    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelector('[data-ac="private-chip"]')?.textContent ?? "")).includes("private, not sent"),
      { timeout: 5_000, timeoutMsg: "the private chip never showed" },
    );
    await expectWithinWindow(['[data-ac="private-chip"]']);
    mkdirSync(SHOTS, { recursive: true });
    await browser.saveScreenshot(`${SHOTS}/u4b-composer-bar.png`);

    await installScriptedTurns([textTurn("private-answer", "PRIVATE-END nothing from the diary.")]);
    await submitComposer("summarize this note");
    await waitForTranscript("PRIVATE-END");
    await waitForIdle();
    const sent = await browser.executeObsidian(({ app }, viewType) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as { service: { getMessages: () => unknown[] } };
      return JSON.stringify(view.service.getMessages());
    }, VIEW_TYPE_AGENT_CHAT);
    expect(sent).not.toContain("DIARY-BODY");
  });
});
