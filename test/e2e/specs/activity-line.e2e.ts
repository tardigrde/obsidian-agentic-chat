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

    // The line is plain text, as in the design: Obsidian's own button chrome
    // (fill, border, shadow) must not win over the plugin's styles.
    const chrome = await browser.execute(() => {
      const head = Array.from(document.querySelectorAll<HTMLElement>('[data-ac="activity-head"]')).at(-1);
      const style = head ? getComputedStyle(head) : null;
      return { background: style?.backgroundColor, border: style?.borderTopWidth, shadow: style?.boxShadow };
    });
    expect(chrome).toEqual({ background: "rgba(0, 0, 0, 0)", border: "0px", shadow: "none" });

    // An empty composer rests the send button muted; typing lights it up.
    const sendBackground = async (text: string) =>
      await browser.execute((value) => {
        const input = document.querySelector<HTMLTextAreaElement>('[data-ac="composer-input"]');
        const send = document.querySelector<HTMLElement>('[data-ac="send"]');
        if (!input || !send) return "missing";
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return `${send.getAttribute("data-ac-state")}|${getComputedStyle(send).backgroundColor}`;
      }, text);
    const typed = await sendBackground("draft");
    const empty = await sendBackground("");
    expect(empty.startsWith("send|")).toBe(true);
    expect(empty).not.toBe(typed);

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
    expect(sources).toEqual(["A", "B", "C"]);
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
        // "needs you" is its own span outside the ellipsis, so a long path never cuts it.
        needsYou: activity?.querySelector(".agentic-chat-activity-state")?.textContent,
        status: document.querySelector('[data-ac="status"]')?.textContent,
        hint: card?.querySelector(".agentic-chat-approval-kbd")?.textContent,
      };
    }, PENDING_APPROVAL);
    expect(state.summary).toMatch(/^Writing /);
    expect(state).toEqual({
      modal: 0,
      inTranscript: true,
      belowActivity: "activity",
      activityState: "needs-you",
      summary: state.summary,
      needsYou: "· needs you",
      status: "Waiting for your approval",
      hint: "⏎ allow · Esc deny",
    });
    // Compact card, as in the design: the head names the action and the path,
    // and the diff fits its box (no horizontal scrollbar).
    await browser.waitUntil(
      async () =>
        (await browser.execute((selector) => document.querySelector(`${selector} .agentic-chat-approval-title`)?.textContent, PENDING_APPROVAL)) ===
        `Create ${WRITE_PATH}`,
      { timeout: 5_000, timeoutMsg: "the approval head never named the action and path" },
    );
    const card = await browser.execute((selector) => {
      const el = document.querySelector<HTMLElement>(selector);
      const diff = el?.querySelector<HTMLElement>(".agentic-chat-diff");
      return {
        desc: !!el?.querySelector(".agentic-chat-approval-desc"),
        diffOverflow: diff ? diff.scrollWidth - diff.clientWidth : -1,
      };
    }, PENDING_APPROVAL);
    expect(card).toEqual({ desc: false, diffOverflow: 0 });
    // As in the design: Allow is the solid accent, Deny is plain text (no
    // border, no fill). Obsidian's own button chrome must not win.
    const buttons = await browser.execute((selector) => {
      const el = document.querySelector<HTMLElement>(selector);
      const allow = el?.querySelector<HTMLElement>('[data-ac="approval-allow"]');
      const deny = el?.querySelector<HTMLElement>('[data-ac="approval-deny"]');
      if (!allow || !deny) return null;
      const probe = document.createElement("span");
      probe.style.color = "var(--interactive-accent)";
      el?.appendChild(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      const a = getComputedStyle(allow);
      const d = getComputedStyle(deny);
      return {
        allowIsAccent: a.backgroundColor === accent,
        allowOpacity: a.opacity,
        denyBackground: d.backgroundColor,
        denyBorder: d.borderTopWidth,
        denyShadow: d.boxShadow,
        // The path is accented, and the head wraps instead of cutting it.
        pathIsAccent: (() => {
          const pathEl = el?.querySelector<HTMLElement>(".agentic-chat-approval-path");
          return !!pathEl && getComputedStyle(pathEl).color === accent;
        })(),
        titleCut: (() => {
          const title = el?.querySelector<HTMLElement>(".agentic-chat-approval-title");
          return !title || title.scrollWidth > title.clientWidth;
        })(),
      };
    }, PENDING_APPROVAL);
    expect(buttons).toEqual({ allowIsAccent: true, allowOpacity: "1", denyBackground: "rgba(0, 0, 0, 0)", denyBorder: "0px", denyShadow: "none", pathIsAccent: true, titleCut: false });
    // A 320px sidebar: the three actions share one row, and the activity
    // summary wraps instead of cutting its counts.
    const narrow = await browser.execute(async (selector) => {
      const view = document.querySelector<HTMLElement>('[data-ac="view"]');
      const el = document.querySelector<HTMLElement>(selector);
      if (!view || !el) return null;
      const old = view.style.width;
      view.style.setProperty("width", "320px");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const top = (hook: string) => Math.round(el.querySelector<HTMLElement>(`[data-ac="${hook}"]`)?.getBoundingClientRect().top ?? -1);
      const summary = el.parentElement?.previousElementSibling?.querySelector<HTMLElement>(".agentic-chat-activity-summary");
      const result = {
        oneRow: top("approval-allow") === top("approval-deny"),
        summaryCut: !summary || summary.scrollWidth > summary.clientWidth + 1 || summary.scrollHeight > summary.clientHeight + 1,
      };
      view.style.width = old;
      return result;
    }, PENDING_APPROVAL);
    expect(narrow).toEqual({ oneRow: true, summaryCut: false });
    if (process.env.AGENTIC_CHAT_SCREENSHOT_DIR) {
      await browser.saveScreenshot(`${process.env.AGENTIC_CHAT_SCREENSHOT_DIR}/approval-card.png`);
    }

    await allowApproval();
    await waitForTranscript("Wrote the plan.");
    await waitForIdle();
    // U4 #4: the settled card leaves; its step row keeps the decision.
    const resolved = await browser.execute(() => {
      const row = Array.from(document.querySelectorAll('[data-ac="step"]')).at(-1);
      return {
        cards: document.querySelectorAll('[data-ac="approval"]').length,
        outcome: row?.getAttribute("data-ac-approval"),
        text: row?.querySelector('[data-ac="step-approval"]')?.textContent,
        status: document.querySelector('[data-ac="status"]')?.textContent ?? "",
      };
    });
    expect(resolved).toEqual({ cards: 0, outcome: "allowed", text: "Allowed by you", status: "" });
    const written = await browser.executeObsidian(async ({ app }, path) => !!app.vault.getAbstractFileByPath(path), WRITE_PATH);
    expect(written).toBe(true);
  });
});
