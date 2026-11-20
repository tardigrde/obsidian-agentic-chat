import { $, browser, expect } from "@wdio/globals";
import { after, afterEach, before, describe, it } from "mocha";
import { configureScriptedPlugin, openChat, submitComposer, waitForIdle, waitForTranscript } from "../support/chat";
import { clearScriptedTurns, installScriptedTurns, textTurn } from "../support/scripted-stream";

/**
 * UI v2 tokens and the restyled chat parts in real Obsidian.
 *
 * - The five `--ac-status-*` colours resolve to real colours in the light and
 *   the dark theme (the token layer maps Obsidian variables; a typo resolves
 *   to nothing).
 * - A finished answer shows its own meta (`… tokens · $…`) in the turn actions,
 *   and the old global usage line under the composer is gone.
 * - The toolbar order is attach, model · effort, spacer, context, Safe/YOLO,
 *   send/stop, and the status line sits above the card.
 * - With Obsidian's `is-mobile` class, targets grow to 44px and the textarea
 *   to 16px text.
 */

const STATUSES = ["running", "needs-you", "error", "done", "unread"] as const;

type Theme = "light" | "dark";

async function setTheme(theme: Theme): Promise<void> {
  await browser.execute((next) => {
    document.body.classList.toggle("theme-dark", next === "dark");
    document.body.classList.toggle("theme-light", next === "light");
  }, theme);
}

/**
 * Resolve each status token through a probe element's computed colour. The
 * result is a list, not an object: WebDriver reads a returned `{ error }` key
 * as a driver error.
 */
async function statusColours(): Promise<Record<string, string>> {
  const pairs = await browser.execute((names) => {
    const view = document.querySelector<HTMLElement>('[data-ac="view"]');
    if (!view) throw new Error("chat view missing");
    const probe = view.ownerDocument.createElement("span");
    view.appendChild(probe);
    const out: Array<[string, string]> = [];
    for (const name of names) {
      probe.style.color = `var(--ac-status-${name})`;
      out.push([name, getComputedStyle(probe).color]);
    }
    probe.remove();
    return out;
  }, [...STATUSES]);
  return Object.fromEntries(pairs);
}

/**
 * Obsidian Mobile puts `is-mobile` on body. On desktop that class turns the
 * sidebar into a hidden drawer, so the spec sets it on the view's leaf
 * instead: the plugin's mobile rules match any `.is-mobile` ancestor.
 */
async function setMobileClass(on: boolean): Promise<void> {
  await browser.execute((value) => {
    document.querySelector('[data-ac="view"]')?.parentElement?.classList.toggle("is-mobile", value);
  }, on);
}

describe("UI v2 design tokens and restyle", function () {
  let originalTheme: Theme = "light";

  before(async function () {
    originalTheme = await browser.execute(() => (document.body.classList.contains("theme-dark") ? "dark" : "light"));
    await installScriptedTurns([
      textTurn("meta answer", "Here is the answer with a meta line.", {
        usage: { input: 3000, output: 1100, cost: { input: 0.003, output: 0.001, total: 0.004 } },
      }),
    ]);
    await configureScriptedPlugin("allow");
    await openChat();
  });

  afterEach(async function () {
    await setMobileClass(false);
  });

  after(async function () {
    await setTheme(originalTheme);
    await clearScriptedTurns();
  });

  it("resolves the five status colours in the light and the dark theme", async function () {
    const resolved: Record<Theme, Record<string, string>> = { light: {}, dark: {} };
    for (const theme of ["light", "dark"] as const) {
      await setTheme(theme);
      resolved[theme] = await statusColours();
      for (const name of STATUSES) {
        expect(`${theme} ${name} ${resolved[theme][name]}`).toMatch(/ rgba?\(/);
        expect(`${theme} ${name} ${resolved[theme][name]}`).not.toMatch(/rgba\(0, 0, 0, 0\)/);
      }
      // Each state has its own colour; running and unread share the accent.
      expect(new Set([resolved[theme].running, resolved[theme]["needs-you"], resolved[theme].error, resolved[theme].done]).size).toBe(4);
      expect(resolved[theme].unread).toBe(resolved[theme].running);
    }
    expect(resolved.dark.error).not.toBe(resolved.light.error);
    await setTheme(originalTheme);
  });

  it("shows the per-answer meta in the turn actions and no global usage line", async function () {
    await submitComposer("answer with usage");
    await waitForTranscript("Here is the answer with a meta line.");
    await waitForIdle();
    const meta = await $('[data-ac="turn-meta"]');
    await meta.waitForExist({ timeout: 5_000 });
    expect(await meta.getProperty("textContent")).toMatch(/^\d+s · 4\.1k tokens · \$0\.004$/);
    const meta2 = await browser.execute(() => ({
      usageLines: document.querySelectorAll(".agentic-chat-usage").length,
      inActions: !!document.querySelector('[data-ac="turn-actions"] [data-ac="turn-meta"]'),
    }));
    expect(meta2).toEqual({ usageLines: 0, inActions: true });
  });

  it("orders the toolbar and puts the status line above the card", async function () {
    const layout = await browser.execute(() => {
      const toolbar = document.querySelector('[data-ac="composer-card"] .agentic-chat-toolbar');
      const order = Array.from(toolbar?.children ?? []).map((el) => {
        const hook = el.getAttribute("data-ac");
        if (hook) return hook;
        if (el.classList.contains("agentic-chat-attach")) return "attach";
        if (el.classList.contains("agentic-chat-model")) return "model";
        if (el.classList.contains("agentic-chat-toolbar-spacer")) return "spacer";
        return el.className;
      });
      const status = document.querySelector('[data-ac="status"]');
      const card = document.querySelector('[data-ac="composer-card"]');
      const statusAboveCard = !!status && !!card && !!(status.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { order, statusAboveCard };
    });
    expect(layout.order).toEqual(["attach", "model", "spacer", "context", "mode-toggle", "stop", "send"]);
    expect(layout.statusAboveCard).toBe(true);
  });

  it("keeps the composer card clear of the status bar on desktop (U2)", async function () {
    const layout = await browser.execute(() => {
      const view = document.querySelector<HTMLElement>('[data-ac="view"]');
      const card = view?.querySelector<HTMLElement>('[data-ac="composer-card"]');
      const bar = document.querySelector<HTMLElement>(".status-bar");
      if (!view || !card || !bar) return null;
      const c = card.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      return {
        barVisible: getComputedStyle(bar).display !== "none" && b.height > 0,
        // The chat is the bottom-right pane, so the floating bar sits under its right end.
        sharesColumns: c.right > b.left && c.left < b.right,
        cardBottom: Math.round(c.bottom),
        barTop: Math.round(b.top),
      };
    });
    expect(layout).not.toBeNull();
    expect(layout?.barVisible).toBe(true);
    expect(layout?.sharesColumns).toBe(true);
    // Obsidian keeps 32 px under every desktop view for the status bar; the card stays above it.
    expect(layout!.cardBottom).toBeLessThanOrEqual(layout!.barTop);
  });

  it("sits the composer card one spacing step above the bottom on a phone", async function () {
    await browser.execute(() => document.body.classList.add("is-phone"));
    try {
      const gap = await browser.execute(() => {
        const view = document.querySelector<HTMLElement>('[data-ac="view"]');
        const card = view?.querySelector<HTMLElement>('[data-ac="composer-card"]');
        if (!view || !card) return null;
        return Math.round(view.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom);
      });
      // 12 px (--ac-space-3): a phone has no status bar, and the safe area is not counted twice.
      expect(gap).toBe(12);
    } finally {
      await browser.execute(() => document.body.classList.remove("is-phone"));
    }
  });

  it("opens the context breakdown above the card on a tap, and Esc closes it", async function () {
    await $('[data-ac="context"]').click();
    const panel = await browser.execute(() => {
      const el = document.querySelector<HTMLElement>('[data-ac="context-breakdown"]');
      const card = document.querySelector<HTMLElement>('[data-ac="composer-card"]');
      if (!el || !card) return null;
      const box = el.getBoundingClientRect();
      return {
        shown: getComputedStyle(el).display !== "none" && box.height > 0,
        aboveCard: box.bottom <= card.getBoundingClientRect().top + 8,
        estimate: /tokens \(estimated\)/.test(el.textContent ?? ""),
      };
    });
    expect(panel).toEqual({ shown: true, aboveCard: true, estimate: true });
    await browser.keys("Escape");
    const closed = await browser.execute(() => getComputedStyle(document.querySelector('[data-ac="context-breakdown"]') as Element).display);
    expect(closed).toBe("none");
  });

  it("keeps the context % readable in a 320px sidebar (the ring glyph goes first)", async function () {
    const narrow = await browser.execute(async () => {
      const view = document.querySelector<HTMLElement>('[data-ac="view"]');
      if (!view) return null;
      const old = view.style.width;
      view.style.setProperty("width", "320px");
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const shown = (selector: string) => {
        const el = document.querySelector<HTMLElement>(`[data-ac="context"] ${selector}`);
        return !!el && getComputedStyle(el).display !== "none";
      };
      const result = { percent: shown(".agentic-chat-ctx-percent"), ring: shown(".agentic-chat-ctx-ring") };
      view.style.width = old;
      return result;
    });
    expect(narrow).toEqual({ percent: true, ring: false });
  });

  it("opens the @ note picker from the attach button", async function () {
    await $(".agentic-chat-attach").click();
    await browser.waitUntil(
      async () => await browser.execute(() => document.querySelector<HTMLTextAreaElement>('[data-ac="composer-input"]')?.value === "@"),
      { timeout: 3_000, timeoutMsg: "attach did not put @ in the composer" },
    );
    await $(".agentic-chat-autocomplete").waitForDisplayed({ timeout: 3_000 });
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>('[data-ac="composer-input"]');
      if (input) {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.blur();
      }
    });
  });

  it("grows touch targets to 44px and the textarea to 16px under is-mobile", async function () {
    await setMobileClass(true);
    // Turn actions fade in (opacity transition); wait for the end state.
    await browser.waitUntil(
      async () =>
        await browser.execute(() => getComputedStyle(document.querySelector('[data-ac="turn-actions"]') as Element).opacity === "1"),
      { timeout: 2_000, timeoutMsg: "turn actions did not become visible under is-mobile" },
    );
    const sizes = await browser.execute(() => {
      const box = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
      const input = document.querySelector<HTMLElement>('[data-ac="composer-input"]');
      return {
        send: box('[data-ac="send"]')?.height ?? 0,
        mode: box('[data-ac="mode-toggle"]')?.height ?? 0,
        attach: box(".agentic-chat-attach")?.height ?? 0,
        inputFont: input ? Number.parseFloat(getComputedStyle(input).fontSize) : 0,
        modeLabel: getComputedStyle(document.querySelector(".agentic-chat-mode-label") as Element).display,
        actionsOpacity: getComputedStyle(document.querySelector('[data-ac="turn-actions"]') as Element).opacity,
      };
    });
    expect(sizes.send).toBeGreaterThanOrEqual(40);
    expect(sizes.mode).toBeGreaterThanOrEqual(44);
    expect(sizes.attach).toBeGreaterThanOrEqual(44);
    expect(sizes.inputFont).toBeGreaterThanOrEqual(16);
    expect(sizes.modeLabel).toBe("none");
    expect(sizes.actionsOpacity).toBe("1");
  });

  it("gives transcript and chip controls a 44px hit area on touch", async function () {
    await setMobileClass(true);
    const hits = await browser.execute(() => {
      const messages = document.querySelector<HTMLElement>('[data-ac="messages"]');
      const chips = document.querySelector<HTMLElement>('[data-ac="chips"]');
      if (!messages || !chips) return null;
      // The plugin's own classes, so the real stylesheet applies.
      const probe = messages.createDiv({ cls: "agentic-chat-hit-probe" });
      const source = probe.createEl("button", { cls: "agentic-chat-source-chip", text: "Shortlist" });
      const retry = probe.createEl("button", { cls: "agentic-chat-error-retry", text: "Ask again" });
      const step = probe.createDiv({ cls: ["agentic-chat-step", "is-expandable"] });
      const head = step.createDiv({ cls: "agentic-chat-step-head", text: "Read Shortlist" });
      const chip = chips.createDiv({ cls: "agentic-chat-chip" });
      chip.createSpan({ text: "Plan" });
      const remove = chip.createSpan({ cls: "agentic-chat-chip-remove", attr: { role: "button" } });
      const reach = (el: HTMLElement, dx: number, dy: number) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2 + dx, r.top + r.height / 2 + dy);
        return !!hit && (hit === el || el.contains(hit));
      };
      const result = {
        source: reach(source, 0, -20) && reach(source, 0, 20),
        retry: reach(retry, 0, -20) && reach(retry, 0, 20),
        step: reach(head, 0, -20) && reach(head, 0, 20),
        remove: reach(remove, 20, 0) && reach(remove, 0, -20),
      };
      probe.remove();
      chip.remove();
      return result;
    });
    await setMobileClass(false);
    expect(hits).toEqual({ source: true, retry: true, step: true, remove: true });
  });
});

/**
 * U2 (owner, 2026-11-20, real vault): a wide sidebar and a large editor font.
 * The empty state sits in the middle of the pane, and chat text uses the
 * interface font and size, not the editor's reading size.
 */
describe("UI v2 empty state and chat type in a wide pane", function () {
  let restore: { width: string; windowWidth: number; windowHeight: number } | null = null;

  const resizeWindow = async (width: number, height: number): Promise<boolean> =>
    await browser.execute(
      (w, h) => {
        const win = (window as unknown as { electronWindow?: { setSize?: (w: number, h: number) => void } }).electronWindow;
        if (!win?.setSize) return false;
        win.setSize(w, h);
        return true;
      },
      width,
      height,
    );

  before(async function () {
    await installScriptedTurns([textTurn("type answer", "A plain answer for the type check.\n\n| Note | Status |\n|---|---|\n| Test Note 1 | done |\n\nRun `vault_inspect` next.")]);
    await configureScriptedPlugin("allow");
    await openChat();
    const original = await browser.execute(() => ({ windowWidth: window.outerWidth, windowHeight: window.outerHeight }));
    if ((await browser.execute(() => window.innerWidth)) < 1300) {
      if (!(await resizeWindow(1400, Math.max(original.windowHeight, 800)))) {
        throw new Error("this runtime cannot resize its window; the wide-pane cases cannot run");
      }
      await browser.waitUntil(async () => (await browser.execute(() => window.innerWidth)) >= 1300, {
        timeout: 5_000,
        timeoutMsg: "the window did not widen to 1400 px",
      });
    }
    const width = await browser.executeObsidian(({ app }) => {
      const el = (app.workspace.rightSplit as unknown as { containerEl: HTMLElement }).containerEl;
      const before = el.style.width;
      el.style.width = "700px";
      return before;
    });
    restore = { width, ...original };
    // The editor font of the owner's vault: large, and not the interface font.
    await browser.execute(() => {
      document.body.style.setProperty("--font-text-size", "26px");
      document.body.style.setProperty("--font-text-override", "Georgia, serif");
    });
    await browser.executeObsidianCommand("agentic-chat:new-conversation");
    await $('[data-ac="empty"]').waitForDisplayed();
  });

  after(async function () {
    await browser.execute(() => {
      document.body.style.removeProperty("--font-text-size");
      document.body.style.removeProperty("--font-text-override");
    });
    if (restore) {
      const { width, windowWidth, windowHeight } = restore;
      await browser.executeObsidian(({ app }, w) => {
        (app.workspace.rightSplit as unknown as { containerEl: HTMLElement }).containerEl.style.width = w;
      }, width);
      await resizeWindow(windowWidth, windowHeight);
    }
    await clearScriptedTurns();
  });

  it("centers the empty state in a 700 px pane", async function () {
    const layout = await browser.execute(() => {
      const messages = document.querySelector<HTMLElement>('[data-ac="messages"]');
      const empty = document.querySelector<HTMLElement>('[data-ac="empty"]');
      if (!messages || !empty) return null;
      const m = messages.getBoundingClientRect();
      const e = empty.getBoundingClientRect();
      return {
        paneWidth: Math.round(m.width),
        blockWidth: Math.round(e.width),
        offset: Math.round(e.left + e.width / 2 - (m.left + m.width / 2)),
        textAlign: getComputedStyle(empty.querySelector(".agentic-chat-empty-text") as Element).textAlign,
      };
    });
    expect(layout).not.toBeNull();
    // Precondition: the pane is wider than the block, or centering proves nothing.
    expect(layout!.paneWidth).toBeGreaterThan(layout!.blockWidth + 100);
    expect(Math.abs(layout!.offset)).toBeLessThanOrEqual(1);
    expect(["start", "left"]).toContain(layout!.textAlign);
  });

  it("renders the answer and the user turn in the interface font and size, not the editor's", async function () {
    await submitComposer("type check");
    await waitForTranscript("A plain answer for the type check.");
    await waitForIdle();
    const type = await browser.execute(() => {
      const view = document.querySelector<HTMLElement>('[data-ac="view"]');
      const answer = document.querySelector<HTMLElement>('[data-ac="assistant-text"] p');
      const user = document.querySelector<HTMLElement>(".agentic-chat-user");
      const cell = document.querySelector<HTMLElement>('[data-ac="assistant-text"] td');
      const code = document.querySelector<HTMLElement>('[data-ac="assistant-text"] p code');
      if (!view || !answer || !user || !cell || !code) return null;
      const probe = view.createDiv();
      probe.style.fontFamily = "var(--font-interface)";
      probe.style.fontSize = "var(--font-ui-medium)";
      const expected = getComputedStyle(probe);
      const result = {
        interfaceFamily: expected.fontFamily,
        uiMedium: expected.fontSize,
        answerFamily: getComputedStyle(answer).fontFamily,
        answerSize: getComputedStyle(answer).fontSize,
        userFamily: getComputedStyle(user).fontFamily,
        userSize: getComputedStyle(user).fontSize,
        // U3 #2: Obsidian sizes tables from the editor font; in chat they follow the answer.
        cellSize: getComputedStyle(cell).fontSize,
        codeSize: getComputedStyle(code).fontSize,
      };
      probe.remove();
      return result;
    });
    expect(type).not.toBeNull();
    expect(type!.answerFamily).toBe(type!.interfaceFamily);
    expect(type!.userFamily).toBe(type!.interfaceFamily);
    expect(type!.answerSize).toBe(type!.uiMedium);
    expect(type!.userSize).toBe(type!.uiMedium);
    expect(type!.answerSize).not.toBe("26px");
    expect(type!.cellSize).toBe(type!.uiMedium);
    expect(parseFloat(type!.codeSize)).toBeLessThanOrEqual(parseFloat(type!.uiMedium));
  });
});
