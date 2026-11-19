import { browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import {
  configureScriptedPlugin,
  noteExists,
  openChat,
  submitComposer,
  waitForIdle,
  waitForTranscript,
} from "../support/chat";
import { clearScriptedTurns, installScriptedTurns, textTurn, toolTurn } from "../support/scripted-stream";

/**
 * Obsidian's default delete setting is the system trash. On a desktop with no
 * trash service (a bare Linux session, Xephyr, Xvfb), `trashFile` can leave the
 * file where it was. The delete tool must not report "Moved to trash" for a note
 * that is still in the vault: it falls back to the vault's own `.trash` folder.
 */

const NOTE = "Trash/Delete me.md";

async function setTrashOption(value: "system" | "local"): Promise<void> {
  await browser.executeObsidian(({ app }, option) => {
    (app.vault as unknown as { setConfig: (key: string, value: unknown) => void }).setConfig("trashOption", option);
  }, value);
}

async function adapterExists(path: string): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }, target) => await app.vault.adapter.exists(target), path);
}

describe("delete falls back when the system trash does nothing", function () {
  before(async function () {
    await browser.executeObsidian(async ({ app }, path) => {
      if (!app.vault.getAbstractFileByPath("Trash")) await app.vault.createFolder("Trash");
      if (!app.vault.getAbstractFileByPath(path)) await app.vault.create(path, "delete me");
    }, NOTE);
    await setTrashOption("system");
    await installScriptedTurns([
      toolTurn("delete note", "e2e-delete-note", "delete", { path: NOTE }),
      textTurn("delete done", "Delete finished."),
    ]);
    await configureScriptedPlugin("allow");
    await openChat();
  });

  after(async function () {
    await setTrashOption("local");
    await clearScriptedTurns();
  });

  it("the note is gone from the vault when the tool says it moved it to trash", async function () {
    await submitComposer("delete the note");
    await waitForTranscript("Delete finished.", 15_000);
    await waitForIdle();

    expect(await noteExists(NOTE)).toBe(false);
    expect(await adapterExists(NOTE)).toBe(false);
  });
});
