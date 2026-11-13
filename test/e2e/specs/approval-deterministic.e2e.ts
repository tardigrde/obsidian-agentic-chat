import { browser, expect, $ } from "@wdio/globals";
import { after, afterEach, before, beforeEach, describe, it } from "mocha";
import { waitForComposerReady } from "../support/layout";
import {
  installScriptedTurns,
  releaseScriptedTurns,
  scriptedCallLabels,
  textTurn,
  toolTurn,
  type ScriptedTurn,
} from "../support/scripted-stream";

const WRITE_NOTE_PATH = "E2E-Deterministic-Write.md";
const WRITE_NOTE_BODY = "deterministic write ok";
const EDIT_NOTE_PATH = "E2E-Deterministic-Edit.md";
const EDIT_BEFORE = "before edit";
const EDIT_AFTER = "after edit";
const DENIED_NOTE_PATH = "E2E-Deterministic-Denied.md";
const INSTRUCTIONS_PATH = "AGENTS.md";
const INSTRUCTIONS_BODY = "# Agent instructions\n- Prefer concise vault updates.";
const REMEMBER_DENY_PATH = "E2E-Remember-Deny.md";
const REMEMBER_DENY_SECOND_PATH = "E2E-Remember-Deny-Second.md";
const EMPTY_FOLDER_PATH = "E2E-Empty-Folder";
const STOP_APPROVAL_NOTE_PATH = "E2E-Stop-Approval.md";

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
  await waitForComposerReady();
}

async function sendPrompt(prompt: string): Promise<void> {
  // A missed first send shifts every later scripted turn by one, so a flaky
  // click here fails the whole spec. Wait until the composer can be hit.
  await waitForComposerReady();
  const input = await $(".agentic-chat-input");
  await input.click();
  await input.setValue(prompt);
  await $(".agentic-chat-send").click();
}

async function runSlashCommand(command: string): Promise<void> {
  await sendPrompt(command);
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
    settings.approval.mutating = "ask";
    settings.approval.perTool = {};
    settings.web.enabled = false;
    await plugin.saveSettings?.();
    return true;
  });
}

async function cleanupNotes(): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }, paths) => {
    for (const path of paths) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof obsidian.TFile || file instanceof obsidian.TFolder) await app.vault.trash(file, true);
    }
  }, [
    WRITE_NOTE_PATH,
    EDIT_NOTE_PATH,
    DENIED_NOTE_PATH,
    INSTRUCTIONS_PATH,
    REMEMBER_DENY_PATH,
    REMEMBER_DENY_SECOND_PATH,
    EMPTY_FOLDER_PATH,
    STOP_APPROVAL_NOTE_PATH,
  ]);
}

async function setApproval(mutating: "allow" | "ask" | "deny"): Promise<void> {
  await browser.executeObsidian(async ({ app }, next) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings as {
      approval: { mutating: string; perTool: Record<string, string> };
    };
    settings.approval.mutating = next.mutating;
    settings.approval.perTool = {};
    await plugin.saveSettings?.();
  }, { mutating });
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

async function allowApproval(): Promise<void> {
  const modal = await $(".agentic-chat-approval");
  await modal.waitForExist({ timeout: 10_000 });
  const allow = await modal.$("button=Allow");
  await allow.waitForExist({ timeout: 5_000 });
  await allow.click();
  await modal.waitForExist({ reverse: true, timeout: 5_000 });
}

async function denyApproval(): Promise<void> {
  const modal = await $(".agentic-chat-approval");
  await modal.waitForExist({ timeout: 10_000 });
  const deny = await modal.$("button=Deny");
  await deny.waitForExist({ timeout: 5_000 });
  await deny.click();
  // Deny is two-step: the first click arms the optional reason field.
  const confirmDeny = await modal.$("button=Confirm Deny");
  await confirmDeny.waitForExist({ timeout: 5_000 });
  // While the deny is armed, the title must say what Confirm will do.
  const title = await browser.execute(() => document.querySelector(".agentic-chat-approval")?.closest(".modal")?.querySelector(".modal-title")?.textContent ?? "");
  expect(title).toMatch(/^Deny "/);
  await confirmDeny.click();
  await modal.waitForExist({ reverse: true, timeout: 5_000 });
}

async function clickRememberApprovalChoice(): Promise<void> {
  const modal = await $(".agentic-chat-approval");
  await modal.waitForExist({ timeout: 10_000 });
  await browser.execute(() => {
    const root = document.querySelector<HTMLElement>(".agentic-chat-approval");
    if (!root) throw new Error("approval modal not found");
    const setting = Array.from(root.querySelectorAll<HTMLElement>(".setting-item")).find(
      (item) => item.querySelector<HTMLElement>(".setting-item-name")?.innerText.trim() === "Don't ask again for this tool",
    );
    if (!setting) throw new Error("remember approval setting not found");
    const toggle = setting.querySelector<HTMLElement>(".checkbox-container");
    const input = setting.querySelector<HTMLInputElement>("input[type='checkbox']");
    if (toggle) toggle.click();
    else if (input) input.click();
    else throw new Error("remember approval toggle not found");
  });
  await modal.waitForExist({ timeout: 2_000 });
}

async function perToolApproval(toolName: string): Promise<string | undefined> {
  return await browser.executeObsidian(async ({ app }, name) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { settings?: Record<string, unknown> }> };
    }).plugins?.plugins?.["agentic-chat"];
    const settings = plugin?.settings as
      | {
          approval?: { perTool?: Record<string, string> };
        }
      | undefined;
    return settings?.approval?.perTool?.[name];
  }, toolName);
}

async function dismissOpenApproval(): Promise<void> {
  const modal = await $(".agentic-chat-approval");
  if (!(await modal.isExisting())) return;
  const deny = await modal.$("button=Deny");
  if (await deny.isExisting()) {
    await deny.click();
    const confirm = await modal.$("button=Confirm Deny");
    if (await confirm.isExisting()) await confirm.click();
  }
  await modal.waitForExist({ reverse: true, timeout: 5_000 }).catch(() => {});
  if (await modal.isExisting()) {
    const stop = await modal.$("button=Stop turn");
    if (await stop.isExisting()) await stop.click();
  }
  await modal.waitForExist({ reverse: true, timeout: 5_000 }).catch(() => {});
}

describe("agentic-chat deterministic approvals", function () {
  before(async function () {
    await cleanupNotes();
    await installScriptedTurns([
      toolTurn("write tool call", "e2e-write", "write", { path: WRITE_NOTE_PATH, content: WRITE_NOTE_BODY }),
      textTurn("write final", "Wrote the deterministic note."),
      toolTurn("edit tool call", "e2e-edit", "edit", {
        path: EDIT_NOTE_PATH,
        edits: [{ oldText: EDIT_BEFORE, newText: EDIT_AFTER }],
      }),
      textTurn("edit final", "Edited the deterministic note."),
      toolTurn("denied write call", "e2e-denied-write", "write", {
        path: DENIED_NOTE_PATH,
        content: "should not be written",
      }),
      textTurn("denied write final", "The denied write was not applied."),
      toolTurn("instruction write call", "e2e-instruction-write", "write", {
        path: INSTRUCTIONS_PATH,
        content: INSTRUCTIONS_BODY,
      }),
      textTurn("instruction write final", "Saved the standing instruction."),
      toolTurn("remember deny write call", "e2e-remember-deny-write", "write", {
        path: REMEMBER_DENY_PATH,
        content: "should not be written",
      }),
      textTurn("remember deny final", "Remembered the deny decision."),
      toolTurn("remember deny second call", "e2e-remember-deny-write-second", "write", {
        path: REMEMBER_DENY_SECOND_PATH,
        content: "should not be written either",
      }),
      textTurn("remember deny second final", "Still denied without asking."),
      textTurn("queue first delayed", "Initial queued answer.", { hold: true }),
      textTurn("queue final", "Queued answer used the edited draft."),
      toolTurn("empty folder delete call", "e2e-delete-empty-folder", "delete", { path: EMPTY_FOLDER_PATH }),
      textTurn("empty folder delete final", "Deleted the empty folder."),
      toolTurn("stop approval call", "e2e-stop-approval", "write", {
        path: STOP_APPROVAL_NOTE_PATH,
        content: "should not be written after stop",
      }),
      textTurn("stop approval final", "This turn should not run."),
    ]);

    const configured = await configurePlugin();
    if (!configured) throw new Error("agentic-chat plugin not found in the test vault");
    await openChat();
  });

  beforeEach(async function () {
    expect(await $(".agentic-chat-approval").isExisting()).toBe(false);
    await releaseScriptedTurns(false);
  });

  afterEach(async function () {
    // Unblock a held turn even when the test fails before its edit step.
    await releaseScriptedTurns(true);
    // A failed test can leave the approval modal open. Close it here so the
    // next test fails on its own assertion, not on an intercepted click.
    await dismissOpenApproval();
    await browser
      .waitUntil(async () => !(await $(".agentic-chat-stop").isDisplayed()), { timeout: 5_000 })
      .catch(() => {});
  });

  it("asks before a scripted write and undo removes the created note", async function () {
    await sendPrompt("scripted write deterministic note");
    await allowApproval();

    await browser.waitUntil(async () => await noteExists(WRITE_NOTE_PATH), {
      timeout: 10_000,
      timeoutMsg: "approved scripted write never appeared in the vault",
    });
    expect(await readNote(WRITE_NOTE_PATH)).toContain(WRITE_NOTE_BODY);

    await runSlashCommand("/undo");
    await browser.waitUntil(async () => !(await noteExists(WRITE_NOTE_PATH)), {
      timeout: 10_000,
      timeoutMsg: "undo did not remove the scripted write",
    });
    expect(await scriptedCallLabels()).toEqual(["write tool call", "write final"]);
  });

  it("asks before a scripted edit and undo restores the prior text", async function () {
    await browser.executeObsidian(async ({ app, obsidian }, note) => {
      const existing = app.vault.getAbstractFileByPath(note.path);
      if (existing instanceof obsidian.TFile) await app.vault.modify(existing, note.before);
      else await app.vault.create(note.path, note.before);
    }, { path: EDIT_NOTE_PATH, before: EDIT_BEFORE });

    await sendPrompt("scripted edit deterministic note");
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const add = document.querySelector<HTMLElement>(".agentic-chat-approval-diff-line.is-add");
          const remove = document.querySelector<HTMLElement>(".agentic-chat-approval-diff-line.is-remove");
          return Boolean(add && remove);
        }),
      { timeout: 5_000, timeoutMsg: "approval diff did not render add/remove lines" },
    );
    const diffStyles = await browser.execute(() => {
      const add = document.querySelector<HTMLElement>(".agentic-chat-approval-diff-line.is-add");
      const remove = document.querySelector<HTMLElement>(".agentic-chat-approval-diff-line.is-remove");
      if (!add || !remove) throw new Error("approval diff lines missing");
      const addStyle = getComputedStyle(add);
      const removeStyle = getComputedStyle(remove);
      return {
        addColor: addStyle.color,
        removeColor: removeStyle.color,
        addBackground: addStyle.backgroundColor,
        removeBackground: removeStyle.backgroundColor,
      };
    });
    expect(diffStyles.addColor).not.toBe(diffStyles.removeColor);
    expect(diffStyles.addBackground).not.toBe(diffStyles.removeBackground);
    await allowApproval();

    await browser.waitUntil(async () => (await readNote(EDIT_NOTE_PATH)).includes(EDIT_AFTER), {
      timeout: 10_000,
      timeoutMsg: "approved scripted edit never updated the note",
    });

    await runSlashCommand("/undo");
    await browser.waitUntil(
      async () => {
        const body = await readNote(EDIT_NOTE_PATH);
        return body.includes(EDIT_BEFORE) && !body.includes(EDIT_AFTER);
      },
      { timeout: 10_000, timeoutMsg: "undo did not restore the pre-edit note body" },
    );
    expect(await scriptedCallLabels()).toEqual(["write tool call", "write final", "edit tool call", "edit final"]);
  });

  it("continues after a denied scripted write without creating the note", async function () {
    await sendPrompt("scripted denied write");
    await denyApproval();

    await expect($(".agentic-chat-messages")).toHaveText(/The denied write was not applied/);
    expect(await noteExists(DENIED_NOTE_PATH)).toBe(false);
    expect(await scriptedCallLabels()).toEqual([
      "write tool call",
      "write final",
      "edit tool call",
      "edit final",
      "denied write call",
      "denied write final",
    ]);
  });

  it("captures # composer text into standing instructions through approval", async function () {
    await sendPrompt("# Prefer concise vault updates.");
    await allowApproval();
    await browser.waitUntil(
      async () => (await $(".agentic-chat-messages").getText()).includes("Saved the standing instruction."),
      { timeout: 8_000, timeoutMsg: "instruction capture final response did not render" },
    );

    expect(await readNote(INSTRUCTIONS_PATH)).toBe(INSTRUCTIONS_BODY);
  });

  it("keeps don't ask again passive and remembers deny after the final choice", async function () {
    await sendPrompt("scripted remember denied write");
    await clickRememberApprovalChoice();
    expect(await $(".agentic-chat-approval").isExisting()).toBe(true);
    await denyApproval();

    await browser.waitUntil(async () => (await perToolApproval("write")) === "deny", {
      timeout: 5_000,
      timeoutMsg: "remembered deny policy was not saved for write",
    });
    expect(await noteExists(REMEMBER_DENY_PATH)).toBe(false);

    await sendPrompt("scripted remember denied write again");
    await browser.pause(250);
    expect(await $(".agentic-chat-approval").isExisting()).toBe(false);
    await expect($(".agentic-chat-messages")).toHaveText(/Still denied without asking/);
    expect(await noteExists(REMEMBER_DENY_SECOND_PATH)).toBe(false);
  });

  it("keeps a plain queued message editable until the active turn finishes", async function () {
    await sendPrompt("scripted queue initial");
    await browser.waitUntil(
      async () => (await $(".agentic-chat-send").getText()).trim() === "Queue",
      { timeout: 5_000, timeoutMsg: "send button did not switch to queue mode" },
    );

    await sendPrompt("queued draft before edit");
    await browser.waitUntil(
      async () => (await $(".agentic-chat-send").getText()).trim() === "Update",
      { timeout: 5_000, timeoutMsg: "send button did not switch to update mode" },
    );
    const input = await $(".agentic-chat-input");
    await input.setValue("queued draft after edit");
    expect(await input.getValue()).toBe("queued draft after edit");
    await browser.execute(() => {
      const target = window as typeof window & { __AGENTIC_CHAT_E2E_RELEASE__?: boolean };
      target.__AGENTIC_CHAT_E2E_RELEASE__ = true;
    });

    await browser.waitUntil(
      async () => (await $(".agentic-chat-messages").getText()).includes("Queued answer used the edited draft."),
      { timeout: 8_000, timeoutMsg: "queued scripted answer did not render" },
    );
    const transcript = await $(".agentic-chat-messages").getText();
    const firstPrompt = transcript.indexOf("scripted queue initial");
    const firstAnswer = transcript.indexOf("Initial queued answer.");
    const originalDraft = transcript.indexOf("queued draft before edit");
    const editedDraft = transcript.indexOf("queued draft after edit");
    const queuedAnswer = transcript.indexOf("Queued answer used the edited draft.");
    if (originalDraft !== -1 || !(firstPrompt < firstAnswer && firstAnswer < editedDraft && editedDraft < queuedAnswer)) {
      throw new Error(`queued transcript order was wrong:\n${transcript}`);
    }
  });

  it("can approve deleting an empty folder", async function () {
    await setApproval("ask");
    await browser.executeObsidian(async ({ app }, path) => {
      if (!app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
    }, EMPTY_FOLDER_PATH);

    await sendPrompt("scripted delete empty folder");
    await allowApproval();

    await browser.waitUntil(async () => !(await noteExists(EMPTY_FOLDER_PATH)), {
      timeout: 10_000,
      timeoutMsg: "approved empty-folder delete did not remove the folder",
    });
    await expect($(".agentic-chat-messages")).toHaveText(/Deleted the empty folder/);
    expect(await scriptedCallLabels()).toEqual([
      "write tool call",
      "write final",
      "edit tool call",
      "edit final",
      "denied write call",
      "denied write final",
      "instruction write call",
      "instruction write final",
      "remember deny write call",
      "remember deny final",
      "remember deny second call",
      "remember deny second final",
      "queue first delayed",
      "queue final",
      "empty folder delete call",
      "empty folder delete final",
    ]);
  });

  it("closes the approval modal when the user stops the turn", async function () {
    await setApproval("ask");
    await sendPrompt("scripted write that will be stopped");

    const modal = await $(".agentic-chat-approval");
    await modal.waitForExist({ timeout: 10_000 });
    const stopTurn = await modal.$("button=Stop turn");
    await stopTurn.waitForDisplayed({ timeout: 5_000 });
    await stopTurn.click();

    await modal.waitForExist({ reverse: true, timeout: 5_000 });
    await browser.waitUntil(
      async () => !(await $(".agentic-chat-stop").isDisplayed()),
      { timeout: 5_000, timeoutMsg: "the stopped turn never settled" },
    );
    await browser.waitUntil(async () => !(await noteExists(STOP_APPROVAL_NOTE_PATH)), {
      timeout: 5_000,
      timeoutMsg: "a stopped approval still wrote its target note",
    });
    const labels = await scriptedCallLabels();
    expect(labels).toContain("stop approval call");
    expect(labels).not.toContain("stop approval final");
  });

  after(async function () {
    await releaseScriptedTurns(true);
    await cleanupNotes();
    await browser.execute(() => {
      const target = window as typeof window & {
        __AGENTIC_CHAT_E2E_TURNS__?: ScriptedTurn[];
        __AGENTIC_CHAT_E2E_CALLS__?: number;
        __AGENTIC_CHAT_E2E_CALL_LOG__?: unknown[];
        __AGENTIC_CHAT_E2E_RELEASE__?: boolean;
      };
      delete target.__AGENTIC_CHAT_E2E_TURNS__;
      delete target.__AGENTIC_CHAT_E2E_CALLS__;
      delete target.__AGENTIC_CHAT_E2E_CALL_LOG__;
      delete target.__AGENTIC_CHAT_E2E_RELEASE__;
    });
  });
});
