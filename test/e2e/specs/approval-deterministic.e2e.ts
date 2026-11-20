import { browser, expect, $ } from "@wdio/globals";
import { after, afterEach, before, beforeEach, describe, it } from "mocha";
import { waitForComposerReady } from "../support/layout";
import {
  allowApproval,
  alwaysAllowApproval,
  denyApproval,
  dismissOpenApproval,
  lastApprovalOutcome,
  PENDING_APPROVAL,
  waitForApproval,
} from "../support/chat";
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
  await $('[data-ac="view"]').waitForExist();
  await waitForComposerReady();
}

async function sendPrompt(prompt: string): Promise<void> {
  // A missed first send shifts every later scripted turn by one, so a flaky
  // click here fails the whole spec. Wait until the composer can be hit.
  await waitForComposerReady();
  const input = await $('[data-ac="composer-input"]');
  await input.click();
  await input.setValue(prompt);
  await $('[data-ac="send"]').click();
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

describe("agentic-chat deterministic approvals", function () {
  before(async function () {
    await cleanupNotes();
    // Each test installs its own queue; the hook must exist before the chat opens.
    await installScriptedTurns([]);

    const configured = await configurePlugin();
    if (!configured) throw new Error("agentic-chat plugin not found in the test vault");
    await openChat();
  });

  beforeEach(async function () {
    expect(await $(PENDING_APPROVAL).isExisting()).toBe(false);
    await releaseScriptedTurns(false);
  });

  afterEach(async function () {
    // Unblock a held turn even when the test fails before its edit step.
    await releaseScriptedTurns(true);
    // A failed test can leave an approval card pending. Settle it here so the
    // next test fails on its own assertion, not on an intercepted click.
    await dismissOpenApproval();
    await browser
      .waitUntil(async () => !(await $('[data-ac="stop"]').isDisplayed()), { timeout: 5_000 })
      .catch(() => {});
  });

  it("asks before a scripted write and undo removes the created note", async function () {
    await installScriptedTurns([
      toolTurn("write tool call", "e2e-write", "write", { path: WRITE_NOTE_PATH, content: WRITE_NOTE_BODY }),
      textTurn("write final", "Wrote the deterministic note."),
    ]);
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
    await installScriptedTurns([
      toolTurn("edit tool call", "e2e-edit", "edit", {
        path: EDIT_NOTE_PATH,
        edits: [{ oldText: EDIT_BEFORE, newText: EDIT_AFTER }],
      }),
      textTurn("edit final", "Edited the deterministic note."),
    ]);
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
    expect(await scriptedCallLabels()).toEqual(["edit tool call", "edit final"]);
  });

  it("continues after a denied scripted write without creating the note", async function () {
    await installScriptedTurns([
      toolTurn("denied write call", "e2e-denied-write", "write", {
        path: DENIED_NOTE_PATH,
        content: "should not be written",
      }),
      textTurn("denied write final", "The denied write was not applied."),
    ]);
    await sendPrompt("scripted denied write");
    await denyApproval();

    await expect($('[data-ac="messages"]')).toHaveText(/The denied write was not applied/);
    expect(await noteExists(DENIED_NOTE_PATH)).toBe(false);
    expect(await scriptedCallLabels()).toEqual(["denied write call", "denied write final"]);
  });

  it("captures # composer text into standing instructions through approval", async function () {
    await installScriptedTurns([
      toolTurn("instruction write call", "e2e-instruction-write", "write", {
        path: INSTRUCTIONS_PATH,
        content: INSTRUCTIONS_BODY,
      }),
      textTurn("instruction write final", "Saved the standing instruction."),
    ]);
    await sendPrompt("# Prefer concise vault updates.");
    await allowApproval();
    await browser.waitUntil(
      async () => (await $('[data-ac="messages"]').getText()).includes("Saved the standing instruction."),
      { timeout: 8_000, timeoutMsg: "instruction capture final response did not render" },
    );

    expect(await readNote(INSTRUCTIONS_PATH)).toBe(INSTRUCTIONS_BODY);
  });

  it("Always allow remembers allow for the tool, so the next write does not ask", async function () {
    await installScriptedTurns([
      toolTurn("remember allow write call", "e2e-remember-allow-write", "write", {
        path: REMEMBER_DENY_PATH,
        content: "first remembered write",
      }),
      textTurn("remember allow final", "Remembered the allow decision."),
      toolTurn("remember allow second call", "e2e-remember-allow-write-second", "write", {
        path: REMEMBER_DENY_SECOND_PATH,
        content: "second write without asking",
      }),
      textTurn("remember allow second final", "Wrote again without asking."),
    ]);
    await sendPrompt("scripted remember allowed write");
    await alwaysAllowApproval();
    expect(await lastApprovalOutcome()).toBe("always");

    await browser.waitUntil(async () => (await perToolApproval("write")) === "allow", {
      timeout: 5_000,
      timeoutMsg: "remembered allow policy was not saved for write",
    });
    await expect($('[data-ac="messages"]')).toHaveText(/Remembered the allow decision/);

    await sendPrompt("scripted remember allowed write again");
    // The remembered allow answers without a card; wait for the final turn.
    await expect($('[data-ac="messages"]')).toHaveText(/Wrote again without asking/);
    expect(await $(PENDING_APPROVAL).isExisting()).toBe(false);
    expect(await readNote(REMEMBER_DENY_SECOND_PATH)).toBe("second write without asking");
    await setApproval("ask");
  });

  it("keeps a plain queued message editable until the active turn finishes", async function () {
    await installScriptedTurns([
      textTurn("queue first delayed", "Initial queued answer.", { hold: true }),
      textTurn("queue final", "Queued answer used the edited draft."),
    ]);
    await sendPrompt("scripted queue initial");
    await browser.waitUntil(
      async () => (await $('[data-ac="send"]').getAttribute("data-ac-state")) === "queue",
      { timeout: 5_000, timeoutMsg: "send button did not switch to queue mode" },
    );

    await sendPrompt("queued draft before edit");
    await browser.waitUntil(
      async () => (await $('[data-ac="send"]').getAttribute("data-ac-state")) === "update",
      { timeout: 5_000, timeoutMsg: "send button did not switch to update mode" },
    );
    const input = await $('[data-ac="composer-input"]');
    await input.setValue("queued draft after edit");
    expect(await input.getValue()).toBe("queued draft after edit");
    await browser.execute(() => {
      const target = window as typeof window & { __AGENTIC_CHAT_E2E_RELEASE__?: boolean };
      target.__AGENTIC_CHAT_E2E_RELEASE__ = true;
    });

    await browser.waitUntil(
      async () => (await $('[data-ac="messages"]').getText()).includes("Queued answer used the edited draft."),
      { timeout: 8_000, timeoutMsg: "queued scripted answer did not render" },
    );
    const transcript = await $('[data-ac="messages"]').getText();
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
    await installScriptedTurns([
      toolTurn("empty folder delete call", "e2e-delete-empty-folder", "delete", { path: EMPTY_FOLDER_PATH }),
      textTurn("empty folder delete final", "Deleted the empty folder."),
    ]);
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
    await expect($('[data-ac="messages"]')).toHaveText(/Deleted the empty folder/);
    expect(await scriptedCallLabels()).toEqual(["empty folder delete call", "empty folder delete final"]);
  });

  it("resolves the approval card as stopped when the user stops the turn", async function () {
    await installScriptedTurns([
      toolTurn("stop approval call", "e2e-stop-approval", "write", {
        path: STOP_APPROVAL_NOTE_PATH,
        content: "should not be written after stop",
      }),
      textTurn("stop approval final", "This turn should not run."),
    ]);
    await setApproval("ask");
    await sendPrompt("scripted write that will be stopped");

    await waitForApproval();
    // The card is inline (no modal) and the composer's Stop is in reach.
    expect(await $(".modal-container").isExisting()).toBe(false);
    await $('[data-ac="stop"]').click();

    await $(PENDING_APPROVAL).waitForExist({ reverse: true, timeout: 5_000 });
    expect(await lastApprovalOutcome()).toBe("stopped");
    await browser.waitUntil(
      async () => !(await $('[data-ac="stop"]').isDisplayed()),
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

  it("allows with Enter and starts the deny with Esc", async function () {
    await installScriptedTurns([
      toolTurn("enter allow call", "e2e-enter-allow", "write", { path: WRITE_NOTE_PATH, content: "enter allowed" }),
      textTurn("enter allow final", "Allowed by Enter."),
      toolTurn("esc deny call", "e2e-esc-deny", "write", { path: DENIED_NOTE_PATH, content: "should not be written" }),
      textTurn("esc deny final", "Denied by Esc."),
    ]);
    await setApproval("ask");
    await sendPrompt("scripted enter allow");
    await waitForApproval();
    // The card takes focus when the composer is empty.
    await browser.waitUntil(
      async () => await browser.execute((selector) => document.activeElement === document.querySelector(selector), PENDING_APPROVAL),
      { timeout: 3_000, timeoutMsg: "the approval card did not take focus" },
    );
    await browser.keys("Enter");
    await $(PENDING_APPROVAL).waitForExist({ reverse: true, timeout: 5_000 });
    expect(await lastApprovalOutcome()).toBe("allowed");
    await expect($('[data-ac="messages"]')).toHaveText(/Allowed by Enter/);
    expect(await readNote(WRITE_NOTE_PATH)).toBe("enter allowed");

    await sendPrompt("scripted esc deny");
    await waitForApproval();
    await browser.waitUntil(
      async () => await browser.execute((selector) => document.activeElement === document.querySelector(selector), PENDING_APPROVAL),
      { timeout: 3_000, timeoutMsg: "the approval card did not take focus" },
    );
    await browser.keys("Escape");
    await browser.waitUntil(async () => (await $(PENDING_APPROVAL).getAttribute("data-ac-state")) === "deny-armed", {
      timeout: 3_000,
      timeoutMsg: "Esc did not arm the deny",
    });
    // Focus is in the reason field; Enter there confirms the deny.
    await browser.keys(["n", "o", "Enter"]);
    await $(PENDING_APPROVAL).waitForExist({ reverse: true, timeout: 5_000 });
    expect(await lastApprovalOutcome()).toBe("denied");
    await expect($('[data-ac="messages"]')).toHaveText(/Denied by Esc/);
    expect(await noteExists(DENIED_NOTE_PATH)).toBe(false);
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
