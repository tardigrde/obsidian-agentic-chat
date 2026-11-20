import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import {
  allowApproval,
  configureScriptedPlugin,
  openChat,
  PENDING_APPROVAL,
  submitComposer,
  waitForApproval,
  waitForIdle,
  waitForTranscript,
} from "../support/chat";
import { clearScriptedTurns, installScriptedTurns, textTurn, toolBatch, toolTurn } from "../support/scripted-stream";

/**
 * The activity line and the inline approval card in real Obsidian.
 *
 * - One line per turn: three reads and one failed fetch read
 *   `Read 3 notes · 1 failed`, collapsed, and expand to four rows.
 * - An approval renders as a card below the turn's activity line, never as a
 *   modal; the line says `needs you` while it waits.
 */

const NOTES = ["Activity/A.md", "Activity/B.md", "Activity/C.md"];
const WRITE_PATH = "Activity/Plan.md";

describe("activity line and inline approval", function () {
  before(async function () {
    await browser.executeObsidian(async ({ app }, paths) => {
      if (!app.vault.getAbstractFileByPath("Activity")) await app.vault.createFolder("Activity");
      for (const path of paths) if (!app.vault.getAbstractFileByPath(path)) await app.vault.create(path, `# ${path}`);
    }, NOTES);
    await installScriptedTurns([
      toolBatch("reads", [
        { id: "a-r1", name: "read", args: { path: NOTES[0] } },
        { id: "a-r2", name: "read", args: { path: NOTES[1] } },
        { id: "a-f1", name: "fetch_url", args: { url: "https://vendors.example.com/pricing" } },
        { id: "a-r3", name: "read", args: { path: NOTES[2] } },
      ]),
      textTurn("answer", "Read the three notes; the pricing page failed."),
      toolTurn("write", "a-w1", "write", { path: WRITE_PATH, content: "# Plan" }),
      textTurn("written", "Wrote the plan."),
    ]);
    await configureScriptedPlugin("ask");
    await openChat();
  });

  after(async function () {
    await clearScriptedTurns();
    await browser.executeObsidian(async ({ app, obsidian }) => {
      const folder = app.vault.getAbstractFileByPath("Activity");
      if (folder instanceof obsidian.TFolder) await app.vault.trash(folder, true);
    });
  });

  it("shows one collapsed line per turn and four rows when expanded", async function () {
    await submitComposer("read my activity notes");
    await waitForTranscript("the pricing page failed");
    await waitForIdle();

    const line = await browser.execute(() => {
      const activities = Array.from(document.querySelectorAll<HTMLElement>('[data-ac="activity"]')).filter(
        (el) => !el.classList.contains("is-hidden"),
      );
      const last = activities.at(-1);
      return {
        count: activities.length,
        state: last?.getAttribute("data-ac-state"),
        summary: last?.querySelector(".agentic-chat-activity-summary")?.textContent,
        fail: last?.querySelector(".agentic-chat-activity-fail")?.textContent,
        expanded: last?.querySelector('[data-ac="activity-head"]')?.getAttribute("aria-expanded"),
        rows: Array.from(last?.querySelectorAll('[data-ac="step"]') ?? []).map((row) => row.getAttribute("data-ac-state")),
        bodyShown: last ? getComputedStyle(last.querySelector('[data-ac="activity-body"]') as Element).display !== "none" : false,
      };
    });
    expect(line).toEqual({
      count: 1,
      state: "done",
      summary: "Read 3 notes",
      fail: "· 1 failed",
      expanded: "false",
      rows: ["done", "done", "error", "done"],
      bodyShown: false,
    });

    await $('[data-ac="activity-head"]').click();
    const rows = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-ac="step"]')).map((row) => ({
        shown: row.getBoundingClientRect().height > 0,
        verb: row.querySelector(".agentic-chat-step-name")?.textContent,
      })),
    );
    expect(rows).toEqual([
      { shown: true, verb: "Read" },
      { shown: true, verb: "Read" },
      { shown: true, verb: "Fetch" },
      { shown: true, verb: "Read" },
    ]);
    // The turn's sources sit under the answer, the failed fetch excluded.
    const sources = await browser.execute(() =>
      Array.from(document.querySelectorAll(".agentic-chat-source-chip-name")).map((el) => el.textContent),
    );
    expect(sources).toEqual(["A.md", "B.md", "C.md"]);
  });

  it("renders an approval as an inline card below the activity line, never a modal", async function () {
    await submitComposer("write the plan");
    await waitForApproval();
    const state = await browser.execute((selector) => {
      const card = document.querySelector<HTMLElement>(selector);
      const activity = card?.parentElement?.previousElementSibling;
      return {
        modal: document.querySelectorAll(".modal-container").length,
        inTranscript: !!card?.closest('[data-ac="messages"]'),
        belowActivity: activity?.getAttribute("data-ac"),
        activityState: activity?.getAttribute("data-ac-state"),
        summary: activity?.querySelector(".agentic-chat-activity-summary")?.textContent,
        status: document.querySelector('[data-ac="status"]')?.textContent,
        hint: card?.querySelector(".agentic-chat-approval-kbd")?.textContent,
      };
    }, PENDING_APPROVAL);
    expect(state.summary).toMatch(/ · needs you$/);
    expect(state).toEqual({
      modal: 0,
      inTranscript: true,
      belowActivity: "activity",
      activityState: "needs-you",
      summary: state.summary,
      status: "Waiting for your approval",
      hint: "⏎ allow · Esc deny",
    });
    if (process.env.AGENTIC_CHAT_SCREENSHOT_DIR) {
      await browser.saveScreenshot(`${process.env.AGENTIC_CHAT_SCREENSHOT_DIR}/approval-card.png`);
    }

    await allowApproval();
    await waitForTranscript("Wrote the plan.");
    await waitForIdle();
    const resolved = await browser.execute(() => {
      const card = Array.from(document.querySelectorAll('[data-ac="approval"]')).at(-1);
      return {
        outcome: card?.getAttribute("data-ac-state"),
        text: card?.querySelector(".agentic-chat-approval-outcome")?.textContent,
        status: document.querySelector('[data-ac="status"]')?.textContent ?? "",
      };
    });
    expect(resolved).toEqual({ outcome: "allowed", text: "Allowed once", status: "" });
    const written = await browser.executeObsidian(async ({ app }, path) => !!app.vault.getAbstractFileByPath(path), WRITE_PATH);
    expect(written).toBe(true);
  });
});
