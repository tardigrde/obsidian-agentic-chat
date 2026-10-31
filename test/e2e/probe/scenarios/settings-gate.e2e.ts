import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { expectNoHorizontalOverflow, expectWithinViewport } from "../../support/layout";
import { mark, writeMetrics } from "../../support/record";
import {
  configurePlugin,
  installScriptedTurns,
  noteExists,
  openChat,
  readApprovalPerTool,
  readNote,
  sendPrompt,
  trashNotes,
  waitForScriptedCalls,
  type ScriptedTurn,
} from "../support/probe-helpers";
import {
  closeAgenticChatSettings,
  openAgenticChatSettings,
  selectSettingsTab,
  setSettingSelect,
  waitForSetting,
} from "../../support/settings-ui";

const DENIED_NOTE = "Probe-Settings-Gate-Denied.md";
const ALLOWED_NOTE = "Probe-Settings-Gate-Allowed.md";

function toolTurn(label: string, id: string, path: string, content: string): ScriptedTurn {
  return {
    label,
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name: "write", arguments: { path, content } }],
  };
}

function textTurn(label: string, text: string): ScriptedTurn {
  return { label, stopReason: "stop", content: [{ type: "text", text }] };
}

/**
 * Acceptance probe for the recorder:
 * a per-tool deny blocks a write, the settings UI flips it to allow, and the
 * identical write succeeds. One continuous recording, settings popout in frame.
 */
describe("probe: settings gate", function () {
  this.timeout(180_000);

  before(async function () {
    await trashNotes([DENIED_NOTE, ALLOWED_NOTE]);
    await installScriptedTurns([
      toolTurn("denied write", "probe-denied-write", DENIED_NOTE, "probe denied"),
      textTurn("denied final", "The write was blocked by the per-tool deny."),
      toolTurn("allowed write", "probe-allowed-write", ALLOWED_NOTE, "probe allowed"),
      textTurn("allowed final", "The write was allowed."),
    ]);
    await configurePlugin({
      provider: "openrouter",
      openrouterApiKey: "e2e-scripted-key",
      mode: "safe",
      approval: { mutating: "allow", perTool: { write: "deny" }, workingDirs: [] },
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
    await trashNotes([DENIED_NOTE, ALLOWED_NOTE]);
  });

  it("records a denied write, flips the override, and records the write succeeding", async function () {
    await mark("chat open");

    await sendPrompt("write the denied probe note");
    await waitForScriptedCalls(2);
    await browser.waitUntil(
      async () => (await $(".agentic-chat-messages").getText()).includes("blocked"),
      { timeout: 5_000, timeoutMsg: "the denied tool result never rendered" },
    );
    expect(await noteExists(DENIED_NOTE)).toBe(false);
    await mark("write blocked by per-tool deny");
    await browser.pause(1_200);

    await openAgenticChatSettings();
    await selectSettingsTab("Approval");
    await waitForSetting("Write file");
    await mark("approval settings open");
    await browser.pause(1_400);

    await setSettingSelect("Write file", "allow");
    await browser.waitUntil(async () => (await readApprovalPerTool("write")) === "allow", {
      timeout: 5_000,
      timeoutMsg: "the write override did not save",
    });
    await mark("write override set to allow");
    await browser.pause(1_200);

    await closeAgenticChatSettings();
    await browser.pause(700);
    await mark("back in chat");

    await sendPrompt("write the allowed probe note");
    await waitForScriptedCalls(4);
    await browser.waitUntil(async () => await noteExists(ALLOWED_NOTE), {
      timeout: 10_000,
      timeoutMsg: "the allowed write never created the note",
    });
    expect(await readNote(ALLOWED_NOTE)).toContain("probe allowed");
    await browser.waitUntil(
      async () => (await $(".agentic-chat-messages").getText()).includes("allowed"),
      { timeout: 5_000, timeoutMsg: "the allowed tool result never rendered" },
    );
    await mark("write allowed");

    await expectNoHorizontalOverflow(".agentic-chat-view");
    await expectWithinViewport(".agentic-chat-input");

    await writeMetrics({
      mode: "scripted",
      setting: "approval.perTool.write",
      before: "deny",
      after: "allow",
      deniedNoteCreated: await noteExists(DENIED_NOTE),
      allowedNoteContent: await readNote(ALLOWED_NOTE),
      finalOverride: await readApprovalPerTool("write"),
    });

    // Hold the final state so the recording does not end on a closing window.
    await browser.pause(1_500);
  });
});
