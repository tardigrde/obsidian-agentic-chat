import { browser, expect, $ } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { waitForComposerReady } from "../support/layout";
import {
  clearScriptedTurns,
  installScriptedTurns,
  releaseScriptedTurns,
  scriptedCallLabels,
  textTurn,
  toolTurn,
} from "../support/scripted-stream";

/**
 * `rename` must not open Obsidian's "Update links?" modal. With
 * `alwaysUpdateLinks` off, backlinks present, and no user to answer, the modal
 * blocks the tool call and the turn hangs until the provider timeout. The
 * product path has to do the modal's one-off choice itself.
 */

const OLD_PATH = "Old.md";
const NEW_PATH = "New.md";
const SOURCE_PATH = "Source.md";

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $('[data-ac="view"]').waitForExist();
  await waitForComposerReady();
}

async function sendPrompt(prompt: string): Promise<void> {
  await waitForComposerReady();
  const input = await $('[data-ac="composer-input"]');
  await input.click();
  await input.setValue(prompt);
  await $('[data-ac="send"]').click();
}

async function configurePlugin(): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) return false;
    const settings = plugin.settings as {
      provider: string;
      openrouterApiKey: string;
      mode: string;
      approval: { mutating: string; perTool: Record<string, string> };
      web: { enabled: boolean };
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = "e2e-scripted-key";
    settings.mode = "safe";
    settings.approval.mutating = "allow";
    settings.approval.perTool = {};
    settings.web.enabled = false;
    await plugin.saveSettings?.();
    return true;
  });
}

async function setAlwaysUpdateLinks(value: boolean): Promise<void> {
  await browser.executeObsidian(async ({ app }, next) => {
    (app.vault as unknown as { setConfig: (key: string, value: boolean) => void }).setConfig(
      "alwaysUpdateLinks",
      next,
    );
  }, value);
}

async function alwaysUpdateLinks(): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }) => {
    const value = (app.vault as unknown as { getConfig: (key: string) => unknown }).getConfig("alwaysUpdateLinks");
    return value === true;
  });
}

async function writeNote(path: string, content: string): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }, note) => {
    const existing = app.vault.getAbstractFileByPath(note.path);
    if (existing instanceof obsidian.TFile) await app.vault.modify(existing, note.content);
    else await app.vault.create(note.path, note.content);
  }, { path, content });
}

async function readNote(path: string): Promise<string> {
  return await browser.executeObsidian(async ({ app, obsidian }, notePath) => {
    const file = app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof obsidian.TFile)) return "";
    return await app.vault.read(file);
  }, path);
}

async function noteExists(path: string): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }, notePath) => app.vault.getAbstractFileByPath(notePath) != null, path);
}

async function waitForBacklink(): Promise<void> {
  await browser.waitUntil(
    async () =>
      await browser.executeObsidian(async ({ app }, paths) => {
        const links = app.metadataCache.resolvedLinks as Record<string, Record<string, number>>;
        return (links[paths.source]?.[paths.target] ?? 0) > 0;
      }, { source: SOURCE_PATH, target: OLD_PATH }),
    { timeout: 15_000, timeoutMsg: "metadata cache never resolved the [[Old]] backlink" },
  );
}

async function waitForTurnEnd(timeout = 20_000): Promise<void> {
  await browser.waitUntil(async () => !(await $('[data-ac="stop"]').isDisplayed()), {
    timeout,
    timeoutMsg: "the rename turn never settled",
  });
}

/** Close any Obsidian modal left open by a failed run so cleanup can proceed. */
async function dismissOpenModals(): Promise<void> {
  await browser.keys("Escape").catch(() => {});
  const open = await browser.execute(() => {
    const containers = Array.from(document.querySelectorAll<HTMLElement>(".modal-container"));
    for (const container of containers) {
      const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
      const choice =
        buttons.find((button) => /^(just once|no|cancel|close)$/i.test(button.textContent?.trim() ?? "")) ??
        container.querySelector<HTMLButtonElement>(".modal-close-button");
      choice?.click();
    }
    return containers.length;
  });
  if (open > 0) {
    await browser.waitUntil(async () => !(await $(".modal-container").isExisting()), {
      timeout: 3_000,
      timeoutMsg: "a stray modal did not close",
    });
  }
}

describe("agentic-chat rename without link modal", function () {
  before(async function () {
    await installScriptedTurns([
      toolTurn("rename", "e2e-rename", "rename", { path: OLD_PATH, newPath: NEW_PATH }),
      textTurn("done", "Renamed."),
    ]);
    const configured = await configurePlugin();
    if (!configured) throw new Error("agentic-chat plugin not found in the test vault");
    await openChat();
  });

  after(async function () {
    await releaseScriptedTurns(true);
    await dismissOpenModals();
    await browser.executeObsidian(async ({ app, obsidian }, paths) => {
      for (const path of paths) {
        const entry = app.vault.getAbstractFileByPath(path);
        if (entry instanceof obsidian.TFile || entry instanceof obsidian.TFolder) await app.vault.trash(entry, true);
      }
    }, [OLD_PATH, NEW_PATH, SOURCE_PATH]);
    await setAlwaysUpdateLinks(true);
    await clearScriptedTurns();
  });

  it("renames with backlinks while auto-update is off, without opening a modal", async function () {
    await setAlwaysUpdateLinks(false);
    await writeNote(OLD_PATH, "old note body");
    await writeNote(SOURCE_PATH, "Link to [[Old]].");
    await waitForBacklink();

    await sendPrompt("Rename Old.md to New.md.");

    await browser.waitUntil(async () => (await scriptedCallLabels()).includes("rename"), {
      timeout: 15_000,
      timeoutMsg: "the scripted rename turn never started",
    });
    // The modal opens during the tool call. Wait until the call either finished
    // or blocked, then give the modal a settle window before asserting.
    await browser.waitUntil(
      async () =>
        (await $(".modal-container").isExisting()) ||
        (await noteExists(NEW_PATH)) ||
        !(await $('[data-ac="stop"]').isDisplayed()),
      { timeout: 15_000, timeoutMsg: "the scripted rename neither ran nor settled" },
    );
    // A blocking link modal would hang the turn, so the turn must end first.
    await waitForTurnEnd();
    expect(await $(".modal-container").isExisting()).toBe(false);
    expect(await scriptedCallLabels()).toContain("rename");
    expect(await noteExists(NEW_PATH)).toBe(true);
    expect(await noteExists(OLD_PATH)).toBe(false);
    expect(await readNote(SOURCE_PATH)).toContain("[[New]]");
    // The one-off toggle must not change the user's preference.
    expect(await alwaysUpdateLinks()).toBe(false);
    expect(await scriptedCallLabels()).toEqual(["rename", "done"]);
  });
});
