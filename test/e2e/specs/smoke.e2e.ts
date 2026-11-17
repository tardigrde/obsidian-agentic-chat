import { browser, expect, $, $$ } from "@wdio/globals";
import { afterEach, before, describe, it } from "mocha";
import {
  allowApproval,
  configureScriptedPlugin,
  denyApproval,
  dismissOpenApproval,
  latestInfoText,
  noteExists,
  openChat,
  readNote,
  submitComposer,
  transcriptText,
  trashPaths,
  VIEW_TYPE_AGENT_CHAT,
  waitForIdle,
  waitForTranscript,
} from "../support/chat";
import { composerHitTest } from "../support/layout";
import { installScriptedTurns, releaseScriptedTurns, scriptedCallLabels, textTurn, toolTurn } from "../support/scripted-stream";
import {
  closeAgenticChatSettings,
  openAgenticChatSettings,
  readSecret,
  readSettingSelect,
  readSettingText,
  readStoredData,
  selectSettingsTab,
  setSettingSelect,
  setSettingText,
  waitForAgenticChatSetting,
  waitForSetting,
} from "../support/settings-ui";

/**
 * The smoke proves the seams unit tests cannot reach, one journey per test:
 * the view mounts and can be hit, slash commands route locally, context
 * attaches, a turn renders and stops, approvals gate the vault, settings
 * persist without leaking the key, sessions survive, Quick Ask edits, and the
 * autocomplete menu is visible. No model and no key: every turn is scripted.
 * Each test installs its own scripted turns, so one failure stays in one test
 * (#393 T13).
 */

const WRITE_PATH = "E2E-Smoke-Write.md";
const DENIED_PATH = "E2E-Smoke-Denied.md";
const PRIVATE_NOTE = "Private/Smoke-Secret.md";
const SMOKE_KEY = "smoke-e2e-gateway-placeholder";
const SMOKE_KEY_SECRET_ID = "agentic-chat-openai-compatible-api-key";
const SMOKE_BASE_URL = "https://smoke.example/api";

async function setIgnoredGlobs(globs: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, value) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { settings?: { ignoredGlobs?: string }; saveSettings?: () => Promise<void> }> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    plugin.settings.ignoredGlobs = value;
    await plugin.saveSettings?.();
  }, globs);
}

async function openNote(path: string, body: string): Promise<void> {
  await browser.executeObsidian(
    async ({ app, obsidian }, notePath, noteBody) => {
      const folder = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
      if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
      const existing = app.vault.getAbstractFileByPath(notePath);
      const file = existing instanceof obsidian.TFile ? existing : await app.vault.create(notePath, noteBody);
      if (existing instanceof obsidian.TFile) await app.vault.modify(existing, noteBody);
      await app.workspace.getLeaf(false).openFile(file);
    },
    path,
    body,
  );
}

async function activeChipText(): Promise<string | null> {
  return await browser.execute(
    () => document.querySelector<HTMLElement>(".agentic-chat-chip.is-active-note")?.innerText ?? null,
  );
}

async function sessionRowTitles(): Promise<string[]> {
  return await browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-session-row .agentic-chat-session-title")).map(
      (el) => el.innerText.trim(),
    ),
  );
}

async function openSessionList(): Promise<void> {
  await submitComposer("/sessions");
  await $(".agentic-chat-session-list").waitForExist({ timeout: 5_000 });
}

async function closeSessionList(): Promise<void> {
  // A backdrop click closes an Obsidian modal; it does not depend on focus.
  await browser.execute(() => {
    const container = document.querySelector(".agentic-chat-session-list")?.closest(".modal-container");
    container?.querySelector<HTMLElement>(".modal-bg")?.click();
  });
  await $(".agentic-chat-session-list").waitForExist({ reverse: true, timeout: 5_000 });
}

describe("agentic-chat smoke", function () {
  before(async function () {
    await configureScriptedPlugin("ask");
    // The service reads ignored globs and the scripted-turn hook when it
    // starts, so both are set before the chat opens.
    await setIgnoredGlobs("Private/");
    await installScriptedTurns([]);
    await openChat();
  });

  afterEach(async function () {
    await releaseScriptedTurns(true);
    await dismissOpenApproval();
    // A failed test can leave the session list open; it would cover the next test.
    if (await $(".agentic-chat-session-list").isExisting()) await closeSessionList().catch(() => {});
    await waitForIdle(5_000).catch(() => {});
  });

  it("mounts the chat view with a reachable composer and its toolbar", async function () {
    await expect($(".agentic-chat-field")).toExist();
    await expect($(".agentic-chat-tabs .agentic-chat-tab")).toExist();
    expect((await composerHitTest()).hit).toBe(true);
    await expect($(".agentic-chat-mode-toggle")).toBeDisplayed();
    // The arc gauge exists from first render (hidden until a fill is known).
    await expect($(".agentic-chat-toolbar-left .agentic-chat-ctx-bar")).toExist();
    // Removed surfaces stay removed.
    await expect($(".agentic-chat-plan-tracker")).not.toExist();
    await expect($(".agentic-chat-plan-badge")).not.toExist();

    // The effort knob only offers levels the model supports.
    const KNOWN_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
    const readEffort = async (): Promise<string> =>
      (await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-effort-value")?.innerText.trim() ?? "")).toLowerCase();
    expect(KNOWN_LEVELS).toContain(await readEffort());
    await $(".agentic-chat-effort").click();
    expect(KNOWN_LEVELS).toContain(await readEffort());
  });

  it("routes /help, /init, and /compact locally without a model call", async function () {
    await installScriptedTurns([textTurn("init answer", "Init curated the standing instructions.")]);
    await submitComposer("/help");
    const help = await latestInfoText();
    expect(help).toMatch(/Slash commands/);
    expect(help).not.toMatch(
      /\/(plan|todo|config|mode|project|history|semindex|adddir|add-dir|dirs|working-dirs|todos|followup|thinking)\b/,
    );
    expect(help).not.toMatch(/plan (mode|tracker)/i);

    await submitComposer("/init add e2e standing focus");
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelector<HTMLTextAreaElement>(".agentic-chat-input")?.value ?? "")) === "" &&
        (await transcriptText()).includes("/init add e2e standing focus"),
      { timeout: 5_000, timeoutMsg: "/init did not clear the composer and render its full command text" },
    );
    await waitForTranscript("Init curated the standing instructions.");
    await waitForIdle();

    await submitComposer("/compact preserve e2e compact instructions");
    await waitForTranscript("/compact preserve e2e compact instructions", 5_000);
    const lastSent = await browser.executeObsidian(async ({ app }, viewType) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
        tabs: Array<{ state: { lastSentPrompt: string | null } }>;
        activeTabIndex: number;
      };
      return view.tabs[view.activeTabIndex].state.lastSentPrompt;
    }, VIEW_TYPE_AGENT_CHAT);
    expect(lastSent).not.toBe("/compact preserve e2e compact instructions");
    // `/help` and `/compact` made no model call; only `/init` did.
    expect(await scriptedCallLabels()).toEqual(["init answer"]);
  });

  it("attaches the active note as a chip, but not an ignored note or AGENTS.md", async function () {
    try {
      await openNote("Welcome.md", "# Welcome\nSmoke context.");
      await browser.waitUntil(async () => /Welcome/.test((await activeChipText()) ?? ""), {
        timeout: 5_000,
        timeoutMsg: "the active note did not render as a context chip",
      });

      await openNote(PRIVATE_NOTE, "# Secret\nNever attach.");
      await browser.waitUntil(async () => (await activeChipText()) === null, {
        timeout: 5_000,
        timeoutMsg: "an ignored note rendered as an active-note chip",
      });

      await openNote("AGENTS.md", "# Standing Instructions\nLoaded implicitly.");
      await browser.waitUntil(async () => (await activeChipText()) === null, {
        timeout: 5_000,
        timeoutMsg: "the standing-instructions file rendered as an active-note chip",
      });
    } finally {
      await trashPaths([PRIVATE_NOTE, "Private", "AGENTS.md"]);
    }
  });

  it("renders a scripted turn, treats /plan and /skill as chat, and Stop clears a running turn", async function () {
    await submitComposer("/new");
    await installScriptedTurns([
      textTurn("plain answer", "Scripted smoke answer."),
      textTurn("skill answer", "Skill turn answer."),
      textTurn("held answer", "This answer is held.", { hold: true }),
    ]);

    // `/plan` is gone: it is a normal prompt now, and the model answers it.
    await submitComposer("/plan outline the vault cleanup");
    await waitForTranscript("Scripted smoke answer.");
    await waitForIdle();
    const transcript = await transcriptText();
    expect(transcript.indexOf("/plan outline the vault cleanup")).toBeGreaterThanOrEqual(0);
    expect(transcript.indexOf("/plan outline the vault cleanup")).toBeLessThan(transcript.indexOf("Scripted smoke answer."));
    await expect($(".agentic-chat-plan-badge")).not.toExist();

    // `/skill <name>` names the loaded skill before the turn starts.
    await submitComposer("/skill self-knowledge e2e chip probe");
    await browser.waitUntil(
      async () =>
        await browser.execute(() =>
          Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-info")).some(
            (el) => el.querySelector("summary")?.innerText.trim() === "Skill" && el.innerText.includes("self-knowledge"),
          ),
        ),
      { timeout: 10_000, timeoutMsg: "the Skill block did not name self-knowledge" },
    );
    await waitForTranscript("Skill turn answer.");
    await waitForIdle();

    // A held turn shows Stop; Stop ends the turn and clears the control.
    await submitComposer("hold this turn");
    const stop = await $(".agentic-chat-stop");
    await stop.waitForDisplayed({ timeout: 5_000 });
    await stop.click();
    await waitForIdle(5_000);
    expect(await transcriptText()).not.toContain("This answer is held.");
    expect(await scriptedCallLabels()).toEqual(["plain answer", "skill answer", "held answer"]);
  });

  it("asks before a write: Allow writes and /undo removes it, Deny writes nothing", async function () {
    await configureScriptedPlugin("ask");
    await trashPaths([WRITE_PATH, DENIED_PATH]);
    await installScriptedTurns([
      toolTurn("write call", "smoke-write", "write", { path: WRITE_PATH, content: "smoke write ok" }),
      textTurn("write final", "Wrote the smoke note."),
      toolTurn("denied call", "smoke-denied", "write", { path: DENIED_PATH, content: "must not be written" }),
      textTurn("denied final", "The denied write was not applied."),
    ]);
    try {
      await submitComposer("smoke write a note");
      await allowApproval();
      await browser.waitUntil(async () => (await readNote(WRITE_PATH)).includes("smoke write ok"), {
        timeout: 10_000,
        timeoutMsg: "the approved write never reached the vault",
      });
      await waitForIdle();
      await submitComposer("/undo");
      await browser.waitUntil(async () => !(await noteExists(WRITE_PATH)), {
        timeout: 10_000,
        timeoutMsg: "/undo did not remove the approved write",
      });

      await submitComposer("smoke denied write");
      await denyApproval();
      await waitForTranscript("The denied write was not applied.");
      expect(await noteExists(DENIED_PATH)).toBe(false);
      expect(await scriptedCallLabels()).toEqual(["write call", "write final", "denied call", "denied final"]);
    } finally {
      await trashPaths([WRITE_PATH, DENIED_PATH]);
    }
  });

  it("keeps a settings change after close and reopen, with the key out of data.json", async function () {
    try {
      await openAgenticChatSettings();
      await selectSettingsTab("Models");
      await setSettingSelect("Model provider", "openai-compatible");
      await waitForSetting("Base URL");
      await setSettingText("Base URL", SMOKE_BASE_URL);
      await setSettingText("API key", SMOKE_KEY);
      await waitForAgenticChatSetting(
        (settings) => settings.openaiCompatibleBaseUrl === SMOKE_BASE_URL && settings.openaiCompatibleApiKey === SMOKE_KEY,
        "the Models tab did not save the base URL and key",
      );
      // The key lives in secret storage, never in data.json.
      expect(await readSecret(SMOKE_KEY_SECRET_ID)).toBe(SMOKE_KEY);
      expect(JSON.stringify(await readStoredData())).not.toContain(SMOKE_KEY);

      await closeAgenticChatSettings();
      await openAgenticChatSettings();
      await selectSettingsTab("Models");
      expect(await readSettingSelect("Model provider")).toBe("openai-compatible");
      expect(await readSettingText("Base URL")).toBe(SMOKE_BASE_URL);
    } finally {
      await closeAgenticChatSettings();
      await configureScriptedPlugin("ask");
    }
  });

  it("opens, renames, and deletes a past session from the session list", async function () {
    await submitComposer("/new");
    await installScriptedTurns([textTurn("session answer", "Session smoke answer.")]);
    await submitComposer("session smoke alpha");
    await waitForTranscript("Session smoke answer.");
    await waitForIdle();
    await submitComposer("/new");
    await browser.waitUntil(async () => !(await transcriptText()).includes("Session smoke answer."), {
      timeout: 5_000,
      timeoutMsg: "/new did not start an empty conversation",
    });

    // Rename the seeded session; the new name survives closing the list.
    await openSessionList();
    const titles = await sessionRowTitles();
    const index = titles.findIndex((title) => title.toLowerCase().includes("session smoke alpha"));
    if (index < 0) throw new Error(`the seeded session is not in the list: ${JSON.stringify(titles)}`);
    // One page call: the inline input commits on blur, so a WebDriver focus
    // change between steps would commit the old name.
    await browser.execute(
      (rowIndex, nextName) => {
        const row = document.querySelectorAll<HTMLElement>(".agentic-chat-session-row")[rowIndex];
        const rename = row?.querySelector<HTMLButtonElement>(".agentic-chat-session-rename");
        if (!rename) throw new Error("session rename button not found");
        rename.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        rename.click();
        const input = row.querySelector<HTMLInputElement>(".agentic-chat-session-rename-input");
        if (!input) throw new Error("session rename input not created");
        input.value = nextName;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      },
      index,
      "Smoke renamed session",
    );
    await browser.waitUntil(async () => (await sessionRowTitles()).includes("Smoke renamed session"), {
      timeout: 5_000,
      timeoutMsg: "the renamed title did not render",
    });

    // Open it: the list closes and the old transcript comes back.
    const openIndex = (await sessionRowTitles()).indexOf("Smoke renamed session");
    expect(openIndex).toBeGreaterThanOrEqual(0);
    await (await $$(".agentic-chat-session-row .agentic-chat-session-main"))[openIndex].click();
    await $(".agentic-chat-session-list").waitForExist({ reverse: true, timeout: 5_000 });
    await waitForTranscript("Session smoke answer.", 5_000);

    // Delete it: it is gone after the list reopens.
    await submitComposer("/new");
    await openSessionList();
    const deleteIndex = (await sessionRowTitles()).indexOf("Smoke renamed session");
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    await (await $$(".agentic-chat-session-row"))[deleteIndex].$(".agentic-chat-session-delete").click();
    await browser.waitUntil(async () => !(await sessionRowTitles()).includes("Smoke renamed session"), {
      timeout: 5_000,
      timeoutMsg: "the deleted session row stayed in the list",
    });
    await closeSessionList();
    await openSessionList();
    expect(await sessionRowTitles()).not.toContain("Smoke renamed session");
    await closeSessionList();
  });

  it("applies a Quick Ask edit to selected editor text without a model call", async function () {
    const path = "Notes/Quick Ask.md";
    await browser.executeObsidian(
      async ({ app, obsidian }, notePath, anchorKey, selectedText) => {
        if (!app.vault.getAbstractFileByPath("Notes")) await app.vault.createFolder("Notes");
        const existing = app.vault.getAbstractFileByPath(notePath);
        const body = "quick ask edit";
        const file = existing instanceof obsidian.TFile ? existing : await app.vault.create(notePath, body);
        if (existing instanceof obsidian.TFile) await app.vault.modify(existing, body);
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(file);
        app.workspace.setActiveLeaf(leaf, { focus: true });
        // Keep the leaf and view this test opened. Asking the workspace for the
        // active markdown view later can return another leaf, or none at all.
        const view = leaf.view;
        if (!(view instanceof obsidian.MarkdownView)) throw new Error("Note did not open in a Markdown view");
        await view.setState({ mode: "source", source: false }, { history: false });
        view.editor.focus();
        view.editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: selectedText.length });
        (window as unknown as Record<string, unknown>)[anchorKey] = { leaf, view };
      },
      path,
      QUICK_ASK_ANCHOR,
      QUICK_ASK_SELECTION,
    );
    await browser.waitUntil(refreshQuickAskSelection, {
      timeout: 5_000,
      timeoutMsg: "Quick Ask selection was not ready",
    });

    // The command routes to the active leaf's editor. Re-activate the anchored
    // leaf in the same page call so a stray focus change cannot route it away.
    if (!(await refreshQuickAskSelection())) {
      throw new Error("Quick Ask anchor lost its selection before the command");
    }
    await browser.executeObsidianCommand("agentic-chat:quick-ask-inline-edit");
    const modal = await $(".agentic-chat-quick-ask");
    await modal.waitForExist();
    const target = await browser.execute(
      () => document.querySelector<HTMLElement>(".agentic-chat-quick-ask-target")?.innerText ?? "",
    );
    // A lost selection would fall back to the whole line and still uppercase it.
    expect(target).toContain("Selection");
    // An unknown instruction keeps Accept disabled and says why (#324).
    const unknown = await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(".agentic-chat-quick-ask-instruction");
      if (!input) throw new Error("Quick Ask instruction input not found");
      input.value = "frobnicate";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return {
        text: document.querySelector<HTMLElement>(".agentic-chat-quick-ask-empty")?.innerText ?? "",
        acceptDisabled: document.querySelector<HTMLButtonElement>(".agentic-chat-quick-ask-accept")?.disabled ?? false,
      };
    });
    expect(unknown.text).toContain("No rule matches this instruction.");
    expect(unknown.text).toContain("Try: uppercase");
    expect(unknown.acceptDisabled).toBe(true);
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(".agentic-chat-quick-ask-instruction");
      if (!input) throw new Error("Quick Ask instruction input not found");
      input.value = "uppercase";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await $(".agentic-chat-quick-ask-accept").click();

    const expected = "QUICK ask edit";
    try {
      await browser.waitUntil(
        async () =>
          browser.executeObsidian(async ({ app, obsidian }, notePath) => {
            const file = app.vault.getAbstractFileByPath(notePath);
            if (!(file instanceof obsidian.TFile)) return false;
            return (await app.vault.cachedRead(file)).startsWith("QUICK ask edit");
          }, path),
        { timeout: 5_000, timeoutMsg: "Quick Ask did not update the selected text" },
      );
    } catch (error) {
      const actual = await browser.executeObsidian(
        async ({ app, obsidian }, notePath, anchorKey) => {
          const file = app.vault.getAbstractFileByPath(notePath);
          const view = (window as unknown as Record<string, { view?: unknown } | undefined>)[anchorKey]?.view;
          return {
            note: file instanceof obsidian.TFile ? (await app.vault.cachedRead(file)).slice(0, 40) : null,
            editor: (view as QuickAskView | undefined)?.editor?.getValue().slice(0, 40) ?? null,
            selection: (view as QuickAskView | undefined)?.editor?.getSelection() ?? null,
          };
        },
        path,
        QUICK_ASK_ANCHOR,
      );
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; expected prefix ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        { cause: error },
      );
    } finally {
      await trashPaths([path]);
      await browser.execute((key) => {
        delete (window as unknown as Record<string, unknown>)[key];
      }, QUICK_ASK_ANCHOR);
    }
  });

  it("renders the /sta autocomplete menu above the input card, fully visible", async function () {
    await openChat();
    await browser.execute((text) => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
      if (!textarea) throw new Error("agentic-chat composer is not mounted");
      textarea.focus();
      textarea.value = text;
      textarea.setSelectionRange(text.length, text.length);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }, "/sta");
    const menu = await $(".agentic-chat-autocomplete");
    await menu.waitForDisplayed({ timeout: 5_000 });

    const geometry = await browser.execute(() => {
      const menuEl = document.querySelector<HTMLElement>(".agentic-chat-autocomplete");
      const fieldEl = document.querySelector<HTMLElement>(".agentic-chat-field");
      if (!menuEl || !fieldEl) throw new Error("autocomplete menu or input card is missing");
      const menuRect = menuEl.getBoundingClientRect();
      const fieldRect = fieldEl.getBoundingClientRect();
      // The menu's center must hit the menu itself, not a covering pane.
      const hit = document.elementFromPoint(menuRect.left + menuRect.width / 2, menuRect.top + menuRect.height / 2);
      return {
        rows: menuEl.querySelectorAll(".agentic-chat-autocomplete-item").length,
        menuBottom: menuRect.bottom,
        menuHeight: menuRect.height,
        menuWidth: menuRect.width,
        fieldTop: fieldRect.top,
        hitInsideMenu: Boolean(hit && menuEl.contains(hit)),
      };
    });
    expect(geometry.rows).toBeGreaterThan(0);
    expect(geometry.menuHeight).toBeGreaterThan(0);
    expect(geometry.menuWidth).toBeGreaterThan(0);
    // The card clips with `overflow: hidden`: the menu must sit above it.
    expect(geometry.menuBottom).toBeLessThanOrEqual(geometry.fieldTop + 2);
    expect(geometry.hitInsideMenu).toBe(true);
    await browser.execute(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
      if (!textarea) return;
      textarea.value = "";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
});

// Helpers for the Quick Ask case above. They live after the suite so the
// feature-map line references into this file stay accurate.
/** Window key for the leaf/view that owns the Quick Ask note. `executeObsidian`
 * stringifies every page callback, so a leaf handle cannot live in a local. */
const QUICK_ASK_ANCHOR = "__agenticChatQuickAskAnchor";
/** Text the Quick Ask command must see selected. */
const QUICK_ASK_SELECTION = "quick";

/** The editor surface Quick Ask reads. Structural on purpose: the spec must not
 * import Obsidian values, because page callbacks are stringified. */
type QuickAskEditor = {
  focus(): void;
  getValue(): string;
  getSelection(): string;
  setSelection(from: { line: number; ch: number }, to: { line: number; ch: number }): void;
};
type QuickAskView = { editor?: QuickAskEditor };

/** Make the anchored leaf active and re-apply the Quick Ask selection when it
 * drifted. Every poll repairs the state instead of only reading it: Obsidian can
 * move the active leaf, drop focus, or redraw the editor after `setState`, and
 * any of those silently loses the selection.
 *
 * Returns false when the anchor is gone, the view left the anchored leaf, or the
 * selection does not hold the expected text after the repair. */
async function refreshQuickAskSelection(): Promise<boolean> {
  return browser.executeObsidian(
    async ({ app }, key, expected) => {
      const store = window as unknown as Record<string, { leaf?: unknown; view?: unknown } | undefined>;
      const anchor = store[key];
      if (!anchor) return false;
      const leaf = anchor.leaf as Parameters<typeof app.workspace.setActiveLeaf>[0];
      const view = anchor.view as QuickAskView;
      // A re-opened or moved note must not pass for the note this test drove.
      if (leaf.view !== view || !view.editor) return false;
      app.workspace.setActiveLeaf(leaf, { focus: true });
      view.editor.focus();
      if (view.editor.getSelection() !== expected) {
        view.editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: expected.length });
      }
      return view.editor.getSelection() === expected;
    },
    QUICK_ASK_ANCHOR,
    QUICK_ASK_SELECTION,
  );
}
