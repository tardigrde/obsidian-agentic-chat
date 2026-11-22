import { browser, expect, $ } from "@wdio/globals";
import { after, afterEach, before, describe, it } from "mocha";
import {
  configureScriptedPlugin,
  noteExists,
  openChat,
  submitComposer,
  VIEW_TYPE_AGENT_CHAT,
  waitForIdle,
  waitForTranscript,
} from "../support/chat";
import { expectNoOverlapWithin, expectTextFits } from "../support/layout";
import { clearScriptedTurns, installScriptedTurns, releaseScriptedTurns, textTurn, type ScriptedTurn } from "../support/scripted-stream";

/**
 * U3-B (owner, 2026-11-20, first real-vault session): the chat view findings
 * in real Obsidian. Each test names its item from the U3 card in NEXT.md.
 */

const FOLDER = "U3 Shared";
const NOTE = "U3 Shared/Plan.md";

function turn(label: string, content: ScriptedTurn["content"], options: Partial<ScriptedTurn> = {}): ScriptedTurn {
  const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
  return { label, stopReason, content, ...options } as ScriptedTurn;
}

async function activeIsComposer(): Promise<boolean> {
  return await browser.execute(() => document.activeElement?.getAttribute("data-ac") === "composer-input");
}

async function focusNoteEditor(): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }, path) => {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof obsidian.TFile)) throw new Error(`missing ${path}`);
    let leaf = app.workspace.getLeavesOfType("markdown")[0];
    if (!leaf) leaf = app.workspace.getLeaf("tab");
    await leaf.openFile(file);
    app.workspace.setActiveLeaf(leaf, { focus: true });
    const view = leaf.view as unknown as { editor?: { focus(): void } };
    view.editor?.focus();
  }, NOTE);
  await browser.waitUntil(async () => !(await activeIsComposer()), { timeout: 3_000, timeoutMsg: "the note editor never took focus" });
}

describe("chat view U3-B", function () {
  before(async function () {
    await browser.executeObsidian(async ({ app }, { folder, note }) => {
      if (!app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
      if (!app.vault.getAbstractFileByPath(note)) await app.vault.create(note, "# Plan\n\nStep one.\n");
    }, { folder: FOLDER, note: NOTE });
    // Each test installs its own scripted turns, so one red test stays in one test.
    await installScriptedTurns([]);
    await configureScriptedPlugin("allow");
    await openChat();
  });

  afterEach(async function () {
    // A red test can leave a held turn running: release it and stop the turn.
    await releaseScriptedTurns();
    if (await $('[data-ac="stop"]').isDisplayed()) await $('[data-ac="stop"]').click();
    await waitForIdle(10_000);
    await releaseScriptedTurns(false);
  });

  after(async function () {
    await releaseScriptedTurns();
    await clearScriptedTurns();
    await browser.executeObsidian(async ({ app, obsidian }, folder) => {
      const entry = app.vault.getAbstractFileByPath(folder);
      if (entry instanceof obsidian.TFolder) await app.vault.trash(entry, true);
      const stray = app.vault.getAbstractFileByPath(`${folder}.md`);
      if (stray instanceof obsidian.TFile) await app.vault.trash(stray, true);
    }, FOLDER);
  });

  it("U3 #6: a click on the chat pane, or a switch back to it, focuses the composer", async function () {
    await focusNoteEditor();
    // Plain chat chrome: the empty-state text is no control.
    await $('[data-ac="empty"]').click();
    await browser.waitUntil(activeIsComposer, { timeout: 3_000, timeoutMsg: "a click on the chat pane did not focus the composer" });

    // Back by command or keyboard: no pointer, the leaf just becomes active.
    await focusNoteEditor();
    await browser.executeObsidian(({ app }, type) => {
      const leaf = app.workspace.getLeavesOfType(type)[0];
      app.workspace.setActiveLeaf(leaf, { focus: true });
    }, VIEW_TYPE_AGENT_CHAT);
    await browser.waitUntil(activeIsComposer, { timeout: 3_000, timeoutMsg: "a switch back to the chat did not focus the composer" });
  });

  it("U3 #5 #3 #4: one spinner per turn; thoughts in event order; a folder is never a note link", async function () {
    await installScriptedTurns([
      // Turn 1 (items 3, 4, 5): thought -> read, thought -> list a folder, thought -> answer.
      turn("t1-call1", [
        { type: "thinking", thinking: "FIRST-THOUGHT read the plan" },
        { type: "toolCall", id: "u3-read", name: "read", arguments: { path: NOTE } },
      ], { hold: true, emitUpdates: true }),
      turn("t1-call2", [
        { type: "thinking", thinking: "SECOND-THOUGHT list the folder" },
        { type: "toolCall", id: "u3-list", name: "vault_inspect", arguments: { action: "list", path: FOLDER } },
      ], { emitUpdates: true }),
      turn("t1-call3", [
        { type: "thinking", thinking: "THIRD-THOUGHT answer now" },
        { type: "text", text: `Done. The folder is [[${FOLDER}]].` },
      ], { emitUpdates: true }),
    ]);
    await submitComposer("plan check");
    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelector('[data-ac="activity"]')?.getAttribute("data-ac-state"))) === "running",
      { timeout: 5_000, timeoutMsg: "the turn never started" },
    );
    // Item 5: while the turn runs, exactly one spinner is visible.
    const spinners = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-ac="view"] .agentic-chat-spinner, [data-ac="view"] .agentic-chat-working')).filter(
        (el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== "none",
      ).length,
    );
    expect(spinners).toBe(1);
    // U7 #2: no "Working…" line either; the tab dot and the activity line show the turn.
    const status = await browser.execute(() => {
      const view = document.querySelector('[data-ac="view"]');
      const hidden = view?.querySelector<HTMLElement>(".agentic-chat-sr-only")?.getBoundingClientRect();
      return {
        visibleText: view?.querySelector(".agentic-chat-status")?.textContent ?? "x",
        hiddenWidth: hidden ? Math.round(hidden.width) : -1,
      };
    });
    // The only "Working…" is the 1px screen-reader line.
    expect(status.visibleText).toBe("");
    expect(status.hiddenWidth).toBeLessThanOrEqual(1);
    expect(await browser.execute(() => document.querySelectorAll(".agentic-chat-tab .agentic-chat-dot.is-running").length)).toBeGreaterThanOrEqual(1);
    await releaseScriptedTurns();
    await waitForTranscript("Done. The folder is");
    await waitForIdle();
    await releaseScriptedTurns(false);

    // Item 3: each thought sits between the tool rows of its own model call.
    await $('[data-ac="activity-head"]').click();
    const timeline = await browser.execute(() => {
      const body = Array.from(document.querySelectorAll('[data-ac="activity-body"]')).at(-1);
      const rows = Array.from(body?.querySelectorAll(".agentic-chat-thought:not(.is-empty), [data-ac=\"step\"]") ?? []);
      const thought = body?.querySelector<HTMLElement>(".agentic-chat-thought:not(.is-empty)");
      return {
        order: rows.map((row) =>
          row.classList.contains("agentic-chat-thought")
            ? (row.textContent ?? "").match(/[A-Z]+-THOUGHT/)?.[0] ?? "thought"
            : row.querySelector(".agentic-chat-step-name")?.textContent ?? "step",
        ),
        thought: !!thought,
      };
    });
    expect(timeline.order).toEqual(["FIRST-THOUGHT", "Read", "SECOND-THOUGHT", "List", "THIRD-THOUGHT"]);
    // U4 #2: no folded row shows part of its next line, and no row cuts into another.
    await expectTextFits('[data-ac="thought"]');
    await expectNoOverlapWithin('[data-ac="activity-body"]', '[data-ac="thought"], [data-ac="step"]');

    // Item 4: the List row shows the folder as plain text with a folder icon.
    const listArg = await browser.execute(() => {
      const row = Array.from(document.querySelectorAll('[data-ac="step"]')).find(
        (el) => el.querySelector(".agentic-chat-step-name")?.textContent === "List",
      );
      const arg = row?.querySelector<HTMLElement>(".agentic-chat-step-arg");
      return { link: arg?.classList.contains("is-link") ?? null, folder: arg?.classList.contains("is-folder") ?? null, icon: !!arg?.querySelector("svg") };
    });
    expect(listArg).toEqual({ link: false, folder: true, icon: true });
    await browser.execute(() => {
      Array.from(document.querySelectorAll<HTMLElement>('[data-ac="step"] .agentic-chat-step-arg')).forEach((arg) => arg.click());
      Array.from(document.querySelectorAll<HTMLElement>('[data-ac="assistant-text"] a.internal-link')).forEach((link) => link.click());
    });
    await browser.pause(300);
    // A click on a folder (row or link) never creates `<folder>.md`.
    expect(await noteExists(`${FOLDER}.md`)).toBe(false);
  });

  it("U3 #15: the question shows after the text written before it", async function () {
    await installScriptedTurns([
      // Turn 2 (item 15): text, then ask_user; the answer, then more text.
      turn("t2-call1", [
        { type: "text", text: "TEXT-BEFORE-ASK let me check one thing." },
        { type: "toolCall", id: "u3-ask", name: "ask_user", arguments: { question: "Which plan?", choices: ["Plan A", "Plan B"] } },
      ]),
      textTurn("t2-call2", "TEXT-AFTER-ASK you picked a plan."),
    ]);
    await submitComposer("ask me");
    const choice = await $("button.agentic-chat-ask-choice=Plan A");
    await choice.waitForDisplayed({ timeout: 5_000 });
    await choice.click();
    await waitForTranscript("TEXT-AFTER-ASK");
    await waitForIdle();
    const order = await browser.execute(() => {
      const messages = document.querySelector('[data-ac="messages"]');
      const items = Array.from(messages?.children ?? []);
      const before = items.findIndex((el) => el.textContent?.includes("TEXT-BEFORE-ASK"));
      const record = items.findIndex((el) => el.getAttribute("data-ac") === "ask-record");
      const after = items.findIndex((el) => el.textContent?.includes("TEXT-AFTER-ASK"));
      const recordText = record >= 0 ? items[record].textContent : "";
      return { before, record, after, recordText };
    });
    expect(order.record).toBeGreaterThan(order.before);
    expect(order.after).toBeGreaterThan(order.record);
    expect(order.recordText).toContain("Which plan?");
    expect(order.recordText).toContain("Plan A");
  });

  it("U3 #7: Ctrl+W in the composer deletes the previous word and keeps the pane open", async function () {
    const input = await $('[data-ac="composer-input"]');
    await input.click();
    await input.setValue("hello brave world");
    await browser.keys(["Control", "w"]);
    await browser.pause(300);
    const state = await browser.execute(() => ({
      views: document.querySelectorAll('[data-ac="view"]').length,
      value: document.querySelector<HTMLTextAreaElement>('[data-ac="composer-input"]')?.value ?? null,
    }));
    expect(state).toEqual({ views: 1, value: "hello brave " });

    // Outside the composer, Ctrl+W still closes the chat tab.
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await $('[data-ac="messages"]').click({ x: 0, y: 0 });
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur());
    await browser.keys(["Control", "w"]);
    await browser.waitUntil(async () => (await browser.execute(() => document.querySelectorAll('[data-ac="view"]').length)) === 0, {
      timeout: 3_000,
      timeoutMsg: "Ctrl+W outside the composer no longer closes the chat tab",
    });
  });
});
