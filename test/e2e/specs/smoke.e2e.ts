import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";

/**
 * Base e2e smoke (D1): boots a real Obsidian on a throwaway copy of `test/e2e/vault`,
 * loads this plugin, and exercises the integration seams unit tests can't reach — view
 * registration, the composer card (C4), in-pane slash routing, and active-note
 * attachment. It deliberately avoids the model: every assertion is on UI/wiring that
 * runs without an API key. Part of the full CI e2e suite.
 */

/** Open the chat view and wait for it to mount. */
async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

/** Type a slash command and submit it through the explicit composer control.
 * Clicking avoids version-specific WebDriver key synthesis differences while
 * still exercising the same submit and slash-command route as Enter. */
async function runSlashCommand(command: string): Promise<void> {
  await browser.execute((value) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
    const send = document.querySelector<HTMLButtonElement>(".agentic-chat-send");
    if (!textarea || !send) throw new Error("agentic-chat composer is not mounted");
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    send.click();
  }, command);
}

async function latestInfoText(): Promise<string> {
  await $(".agentic-chat-info").waitForExist();
  return await browser.execute(() => {
    const infos = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-info"));
    return infos.at(-1)?.innerText ?? "";
  });
}

describe("agentic-chat smoke", function () {
  before(async function () {
    await openChat();
  });

  it("renders the unified composer card with a tab and textarea", async function () {
    await expect($(".agentic-chat-field")).toExist();
    await expect($(".agentic-chat-tabs .agentic-chat-tab")).toExist();
    await expect($(".agentic-chat-input")).toExist();
  });

  it("runs an in-pane slash command (/help) without calling the model", async function () {
    await runSlashCommand("/help");
    const info = await $(".agentic-chat-info");
    await info.waitForExist();
    await expect(info).toHaveText(/Slash commands/);
    await expect(info).not.toHaveText(
      /\/(config|mode|project|history|semindex|adddir|add-dir|dirs|working-dirs|todo|todos|followup|thinking)\b/,
    );
  });

  it("clears slash commands immediately and preserves /init tail text in the transcript", async function () {
    await runSlashCommand("/init add e2e standing focus");

    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const input = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
          const messages = document.querySelector<HTMLElement>(".agentic-chat-messages");
          return input?.value === "" && Boolean(messages?.innerText.includes("/init add e2e standing focus"));
        }),
      { timeout: 5_000, timeoutMsg: "/init did not clear the composer and render its full command text" },
    );
  });

  it("routes /compact locally with optional instructions instead of sending it as a model prompt", async function () {
    await runSlashCommand("/compact preserve e2e compact instructions");

    const state = await browser.executeObsidian(async ({ app }, viewType) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
        lastSentPrompt?: string | null;
      };
      return {
        lastSentPrompt: view?.lastSentPrompt ?? null,
        transcript: document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "",
        input: document.querySelector<HTMLTextAreaElement>(".agentic-chat-input")?.value ?? "(missing)",
      };
    }, "agentic-chat-chat-view");

    expect(state.input).toBe("");
    expect(state.transcript).toContain("/compact preserve e2e compact instructions");
    expect(state.lastSentPrompt).not.toBe("/compact preserve e2e compact instructions");
  });

  it("auto-attaches the active note as a context chip", async function () {
    await browser.executeObsidian(async ({ app, obsidian }) => {
      if (!app.vault.getAbstractFileByPath("Notes")) await app.vault.createFolder("Notes");
      const related = app.vault.getAbstractFileByPath("Notes/Related.md");
      const relatedBody = "# Related Context\nOAuth launch diagnostics and research notes.";
      if (related instanceof obsidian.TFile) await app.vault.modify(related, relatedBody);
      else await app.vault.create("Notes/Related.md", relatedBody);

      const existing = app.vault.getAbstractFileByPath("Welcome.md");
      const body = "# Welcome\n#project\nSee [[Notes/Related.md]].\nOAuth launch diagnostics.";
      const file = existing instanceof obsidian.TFile ? existing : await app.vault.create("Welcome.md", body);
      if (existing instanceof obsidian.TFile) await app.vault.modify(existing, body);
      await app.workspace.getLeaf(false).openFile(file);
    });
    const chip = await $(".agentic-chat-chip.is-active-note");
    await chip.waitForExist();
    await expect(chip).toHaveText(/Welcome/);
  });

  it("does not auto-attach root standing-instructions files as ordinary context chips", async function () {
    await browser.executeObsidian(async ({ app, obsidian }) => {
      const existing = app.vault.getAbstractFileByPath("AGENTS.md");
      const body = "# Standing Instructions\nLoaded implicitly.";
      const file = existing instanceof obsidian.TFile ? existing : await app.vault.create("AGENTS.md", body);
      if (existing instanceof obsidian.TFile) await app.vault.modify(existing, body);
      await app.workspace.getLeaf(false).openFile(file);
    });

    await browser.waitUntil(
      async () => await browser.execute(() => document.querySelector(".agentic-chat-chip.is-active-note") == null),
      { timeout: 5_000, timeoutMsg: "standing-instructions file rendered as an automatic active-note chip" },
    );
  });

  it("forgets a saved memory through the memory manager", async function () {
    await browser.executeObsidian(async ({ app }) => {
      const adapter = app.vault.adapter as unknown as {
        exists: (path: string) => Promise<boolean>;
        mkdir: (path: string) => Promise<void>;
        write: (path: string, data: string) => Promise<void>;
      };
      const memoryDir = `${app.vault.configDir}/plugins/agentic-chat/memory`;
      if (!(await adapter.exists(memoryDir))) await adapter.mkdir(memoryDir);
      const memoryPath = `${memoryDir}/memories.jsonl`;
      await adapter.write(
        memoryPath,
        `${JSON.stringify({
          id: "mem-e2e",
          kind: "preference",
          scope: "vault",
          text: "The user prefers concise answers in e2e.",
          enabled: true,
          createdAt: "2026-06-26T00:00:00.000Z",
        })}\n`,
      );
    });

    await runSlashCommand("/memory manage");
    await $(".agentic-chat-action-list").waitForExist();
    await browser.execute(() => {
      const row = Array.from(document.querySelectorAll<HTMLButtonElement>(".agentic-chat-action-row")).find((item) =>
        item.innerText.includes("The user prefers concise answers in e2e."),
      );
      if (!row) throw new Error("memory row not found");
      row.click();
    });
    await browser.waitUntil(async () => (await latestInfoText()).includes("Forgotten"), {
      timeout: 5_000,
      timeoutMsg: "memory forget confirmation did not render",
    });

    const saved = await browser.executeObsidian(async ({ app }) => {
      const raw = await app.vault.adapter.read(
        `${app.vault.configDir}/plugins/agentic-chat/memory/memories.jsonl`,
      );
      return JSON.parse(raw.trim()) as { enabled?: boolean; forgottenAt?: string };
    });
    expect(saved.enabled).toBe(false);
    expect(saved.forgottenAt).toBeTruthy();
  });

  it("renders the context-window arc gauge in the toolbar (NB1)", async function () {
    // The fill element stays a <progress> (.agentic-chat-ctx-bar); its arc look is
    // pure CSS. It exists in the toolbar from first render (hidden until a fill is
    // known), so assert existence, not visibility.
    await expect($(".agentic-chat-toolbar-left .agentic-chat-ctx-bar")).toExist();
  });

  it("renders a dynamic effort knob clamped to supported levels", async function () {
    // Dynamic effort: the knob only offers levels the active model supports and
    // carries the level as its own label (no separate "Effort" text). The
    // rendered value must be a member of the canonical set.
    const knob = await $(".agentic-chat-effort");
    await knob.waitForExist();
    await expect($(".agentic-chat-effort-value")).toExist();
    const readEffortValue = async (): Promise<string> =>
      browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-effort-value")?.innerText.trim() ?? "");
    const value = (await readEffortValue()).toLowerCase();
    const KNOWN_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
    if (!KNOWN_LEVELS.includes(value)) {
      throw new Error(`effort knob rendered an unknown level: "${value}"`);
    }
    // Cycling must keep it within the supported set (no crash, no invalid level).
    await knob.click();
    const next = (await readEffortValue()).toLowerCase();
    if (!KNOWN_LEVELS.includes(next)) {
      throw new Error(`effort knob cycled to an unknown level: "${next}"`);
    }
  });

  it("removed the plan tracker panel and `/todo` command", async function () {
    await expect($(".agentic-chat-plan-tracker")).not.toExist();

    await runSlashCommand("/help");
    const info = await latestInfoText();
    expect(info).not.toMatch(/\/todo\b/);
    expect(info).not.toMatch(/plan tracker/i);
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
    }
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
