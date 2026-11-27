import { mkdirSync } from "node:fs";
import { $, browser, expect } from "@wdio/globals";
import { after, afterEach, before, describe, it } from "mocha";
import {
  allowApproval,
  configureScriptedPlugin,
  openChat,
  submitComposer,
  waitForApproval,
  waitForIdle,
  waitForTranscript,
} from "../support/chat";
import { expectNoOverlapWithin, expectTextFits } from "../support/layout";
import {
  clearScriptedTurns,
  installScriptedTurns,
  mixedTurn,
  releaseScriptedTurns,
  textTurn,
  toolTurn,
  type ScriptedTurn,
} from "../support/scripted-stream";
import { readLastTurnOrder } from "../support/transcript-order";

/**
 * U4-A (owner, 2026-11-21, second real-vault run): the chat timeline in real
 * Obsidian. Each test names its item from the U4 card and asserts the
 * acceptance sentence through the reader's order of the transcript.
 */

const FOLDER = "U4 Timeline";
const NOTES = [`${FOLDER}/One.md`, `${FOLDER}/Two.md`];
const WRITE_PATH = `${FOLDER}/Written.md`;
const SHOTS = "logs/pr-u4a-shots";

function turn(label: string, content: ScriptedTurn["content"], options: Partial<ScriptedTurn> = {}): ScriptedTurn {
  const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
  return { label, stopReason, content, ...options } as ScriptedTurn;
}

async function openLastActivity(): Promise<void> {
  await browser.execute(() => {
    for (const activity of Array.from(document.querySelectorAll<HTMLElement>('[data-ac="activity"]:not(.is-hidden)'))) {
      const head = activity.querySelector<HTMLElement>('[data-ac="activity-head"]');
      if (head?.getAttribute("aria-expanded") === "false") head.click();
    }
  });
}

describe("chat timeline U4-A", function () {
  before(async function () {
    await browser.executeObsidian(async ({ app }, { folder, notes }) => {
      if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
      for (const path of notes) if (!app.vault.getAbstractFileByPath(path)) await app.vault.create(path, `# ${path}\n\nBody.\n`);
    }, { folder: FOLDER, notes: NOTES });
    await installScriptedTurns([]);
    await configureScriptedPlugin("allow");
    await openChat();
  });

  afterEach(async function () {
    await releaseScriptedTurns();
    await browser.execute(() => document.querySelector<HTMLElement>('[data-ac="stop"]')?.click());
  });

  after(async function () {
    await clearScriptedTurns();
    await browser.executeObsidian(async ({ app, obsidian }, folder) => {
      const file = app.vault.getAbstractFileByPath(folder);
      if (file instanceof obsidian.TFolder) await app.vault.trash(file, true);
    }, FOLDER);
  });

  it("U4 #1: text, tool, text reads in that order, live and after a re-render", async function () {
    await installScriptedTurns([
      mixedTurn("m1", [{ text: "MIXED-ONE let me read it:" }, { id: "u4-r1", name: "read", args: { path: NOTES[0] } }]),
      mixedTurn("m2", [{ text: "MIXED-TWO retrying those:" }, { id: "u4-r2", name: "read", args: { path: NOTES[1] } }]),
      textTurn("m3", "MIXED-END both read."),
    ]);
    await submitComposer("read both notes");
    await waitForTranscript("MIXED-END both read.");
    await waitForIdle();
    const expected = ["text:MIXED-ONE let me read it", "step:Read", "text:MIXED-TWO retrying those", "step:Read", "text:MIXED-END both read."];
    expect(await readLastTurnOrder()).toEqual(expected);

    await openLastActivity();
    mkdirSync(SHOTS, { recursive: true });
    await browser.saveScreenshot(`${SHOTS}/u4a-timeline.png`);

    await browser.executeObsidian(({ app }) => {
      const leaf = app.workspace.getLeavesOfType("agentic-chat-chat-view")[0];
      const view = leaf?.view as unknown as { renderTranscript: (m: unknown[]) => void; service: { getMessages: () => unknown[] } };
      view.renderTranscript(view.service.getMessages());
    });
    expect(await readLastTurnOrder()).toEqual(expected);
  });

  it("U4 #2 #3: a thought row is one head (Thought + time), nothing clipped, nothing overlapping", async function () {
    await installScriptedTurns([
      turn("t1", [
        { type: "thinking", thinking: "FIRST-THOUGHT line one\nline two of the trace\nline three" },
        { type: "toolCall", id: "u4-t-r1", name: "read", arguments: { path: NOTES[0] } },
      ], { emitUpdates: true, updateDelayMs: 600 }),
      turn("t2", [
        { type: "thinking", thinking: "SECOND-THOUGHT a long second trace\nthat wraps\nonto more lines" },
        { type: "text", text: "THOUGHT-END done." },
      ], { emitUpdates: true }),
    ]);
    await submitComposer("think then read");
    await waitForTranscript("THOUGHT-END done.");
    await waitForIdle();
    await openLastActivity();

    const rows = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-ac="thought"]:not(.is-empty)'))
        .slice(-2)
        .map((row) => ({
          head: row.querySelector<HTMLElement>(".agentic-chat-thought-head")?.innerText.replace(/\s+/g, " ").trim(),
          bodyShown: getComputedStyle(row.querySelector(".agentic-chat-thought-text") as Element).display !== "none",
          weight: Number(getComputedStyle(row.querySelector(".agentic-chat-thought-label") as Element).fontWeight),
        })),
    );
    // Folded: the label and its time only (`Thought 4s`), never the trace.
    expect(rows[0]?.head).toMatch(/^Thought \d+s$/);
    expect(rows[1]?.head).toMatch(/^Thought( \d+s)?$/);
    expect(rows.map((row) => row.bodyShown)).toEqual([false, false]);
    expect(rows.every((row) => row.weight >= 600)).toBe(true);
    await expectTextFits('[data-ac="thought"]');
    await expectNoOverlapWithin('[data-ac="activity-body"]', '[data-ac="thought"], [data-ac="step"]');

    // A click opens the full trace, still inside its own box.
    await browser.execute(() => document.querySelector<HTMLElement>('[data-ac="thought"]:not(.is-empty) .agentic-chat-thought-head')?.click());
    const opened = await browser.execute(() => {
      const row = document.querySelector<HTMLElement>('[data-ac="thought"]:not(.is-empty)');
      return row ? getComputedStyle(row.querySelector(".agentic-chat-thought-text") as Element).display : "";
    });
    expect(opened).toBe("block");
    await expectTextFits('[data-ac="thought"]');
    await expectNoOverlapWithin('[data-ac="activity-body"]', '[data-ac="thought"], [data-ac="step"]');
  });

  it("U4 #4: an approval waits below the block, then becomes a line on its row", async function () {
    await configureScriptedPlugin("ask");
    await installScriptedTurns([
      toolTurn("w1", "u4-w1", "write", { path: WRITE_PATH, content: "# Written" }),
      textTurn("w2", "WRITE-END written."),
    ]);
    await submitComposer("write a note");
    await waitForApproval();
    expect(await readLastTurnOrder()).toEqual(["step:Write", "approval"]);
    expect(await browser.execute(() => !!document.querySelector('[data-ac="activity"] [data-ac="approval"]'))).toBe(false);

    await allowApproval();
    await waitForTranscript("WRITE-END written.");
    await waitForIdle();
    expect(await readLastTurnOrder()).toEqual(["step:Write", "text:WRITE-END written."]);
    const record = await browser.execute(() => {
      const row = Array.from(document.querySelectorAll('[data-ac="step"]')).at(-1);
      const line = row?.querySelector<HTMLElement>('[data-ac="step-approval"]');
      // The block stays as the user left it (closed), so the settled line is
      // present on the row but folded until the user opens the body.
      return { outcome: row?.getAttribute("data-ac-approval"), line: line?.textContent, visible: (line?.getClientRects().length ?? 0) > 0 };
    });
    expect(record).toEqual({ outcome: "allowed", line: "Allowed by you", visible: false });
    await browser.execute(() => {
      const heads = Array.from(document.querySelectorAll<HTMLElement>('[data-ac="activity-head"]'));
      heads.at(-1)?.click();
    });
    const opened = await browser.execute(() => {
      const row = Array.from(document.querySelectorAll('[data-ac="step"]')).at(-1);
      const line = row?.querySelector<HTMLElement>('[data-ac="step-approval"]');
      return (line?.getClientRects().length ?? 0) > 0;
    });
    expect(opened).toBe(true);
    await configureScriptedPlugin("allow");
  });

  it("U5 #1-#3: a subagent runs in the background; the turn ends, the row keeps running, the report starts a turn", async function () {
    await installScriptedTurns([
      turn("s1", [{ type: "toolCall", id: "u5-sub", name: "subagent", arguments: { agent: "explorer", task: "Critique the plan for gaps" } }]),
      textTurn("s-child", "CHILD-REPORT the plan has two gaps.", { hold: true }),
      textTurn("s-parent", "PARENT-FREE I started the explorer."),
      textTurn("s2", "SUB-END the explorer found two gaps."),
    ]);
    await submitComposer("delegate it");
    await waitForTranscript("PARENT-FREE I started the explorer.");
    await waitForIdle();
    // The parent turn is over while the child still runs: one row, in the activity block, with Stop.
    const running = await browser.execute(() => {
      const row = Array.from(document.querySelectorAll('[data-ac="step"].is-subagent')).at(-1);
      return {
        section: !!document.querySelector(".agentic-chat-subagent-block"),
        inActivity: !!row?.closest('[data-ac="activity"]'),
        running: row?.classList.contains("is-child-running") ?? false,
        stop: !!row?.querySelector('[data-ac="subagent-stop"]'),
      };
    });
    expect(running).toEqual({ section: false, inActivity: true, running: true, stop: true });
    expect(await readLastTurnOrder()).toEqual(["step:Subagent", "text:PARENT-FREE I started th"]);

    await releaseScriptedTurns();
    await waitForTranscript("SUB-END the explorer found two gaps.");
    await waitForIdle();
    const done = await browser.execute(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-ac="step"].is-subagent')).at(-1);
      row?.querySelector<HTMLElement>(".agentic-chat-step-head")?.click();
      return {
        running: row?.classList.contains("is-child-running") ?? true,
        status: row?.querySelector(".agentic-chat-subagent-status")?.textContent,
        report: row?.innerText.includes("CHILD-REPORT") ?? false,
        stop: !!row?.querySelector('[data-ac="subagent-stop"]'),
        event: document.querySelector('[data-ac="subagent-event"] summary')?.textContent,
      };
    });
    expect(done).toEqual({ running: false, status: "done", report: true, stop: false, event: "Subagent explorer (sa-1) reported back" });
    await browser.saveScreenshot(`${SHOTS}/u5-subagent-background.png`);
  });

  it("Stop/Queue: one round button (Stop on an empty draft, Queue with text); Escape stops", async function () {
    await installScriptedTurns([textTurn("hold", "HELD never shown.", { hold: true })]);
    await submitComposer("hold on");
    const shown = async () =>
      await browser.execute(() => {
        const visible = (selector: string) => {
          const el = document.querySelector<HTMLElement>(selector);
          return !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== "none";
        };
        return { stop: visible('[data-ac="stop"]'), send: visible('[data-ac="send"]') };
      });
    await browser.waitUntil(async () => (await shown()).stop, { timeout: 5_000, timeoutMsg: "Stop never showed while the turn ran" });
    expect(await shown()).toEqual({ stop: true, send: false });

    const input = await $('[data-ac="composer-input"]');
    await input.setValue("a follow-up");
    await browser.waitUntil(async () => (await $('[data-ac="send"]').getAttribute("data-ac-state")) === "queue", { timeout: 3_000 });
    expect(await shown()).toEqual({ stop: false, send: true });
    await input.clearValue();
    await browser.execute(() => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-ac="composer-input"]');
      el?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.waitUntil(async () => (await shown()).stop, { timeout: 3_000, timeoutMsg: "Stop did not come back on an empty draft" });

    await input.click();
    await browser.keys(["Escape"]);
    await waitForIdle(5_000);
    expect(await $('[data-ac="send"]').getAttribute("data-ac-state")).toBe("send");
  });
});
