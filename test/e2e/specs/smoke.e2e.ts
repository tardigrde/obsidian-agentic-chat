import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";

/**
 * Base e2e smoke (D1): boots a real Obsidian on a throwaway copy of `test/e2e/vault`,
 * loads this plugin, and exercises the integration seams unit tests can't reach — view
 * registration, the composer card (C4), in-pane slash routing, the working-dir command
 * (C1), and active-note attachment. It deliberately avoids the model: every assertion
 * is on UI/wiring that runs without an API key. Local-only; not part of CI.
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

  it("lists working directories via /dirs (C1)", async function () {
    await runSlashCommand("/dirs");
    const list = await $(".agentic-chat-action-list");
    await list.waitForExist();
    await expect(list).toHaveText(/Add working directory/);
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

  it("surfaces related notes for the active note without a model call", async function () {
    await browser.executeObsidian(async ({ app, obsidian }) => {
      const file = app.vault.getAbstractFileByPath("Welcome.md");
      if (!(file instanceof obsidian.TFile)) throw new Error("Welcome.md fixture is missing");
      await app.workspace.getLeaf(false).openFile(file);
    });
    const panel = await $(".agentic-chat-relevant-notes");
    await panel.waitForDisplayed();
    await browser.waitUntil(
      async () => (await panel.getText()).includes("Related.md"),
      { timeout: 5_000, timeoutMsg: "related notes panel did not suggest the linked note" },
    );
    await expect(panel).toHaveText(/Related\.md/);
  });

  it("switches project workspace and scopes related notes", async function () {
    await browser.executeObsidian(async ({ app, obsidian }) => {
      const plugin = (app as unknown as {
        plugins?: {
          plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }>;
        };
      }).plugins?.plugins?.["agentic-chat"];
      if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
      const settings = plugin.settings as {
        projects: {
          activeProjectId: string;
          items: Array<{
            id: string;
            name: string;
            folders: string[];
            modelId?: string;
            profile?: string;
            systemPrompt?: string;
            tools?: { web?: boolean };
          }>;
        };
        web: { enabled: boolean };
      };
      settings.web.enabled = true;
      settings.projects = {
        activeProjectId: "",
        items: [
          {
            id: "alpha",
            name: "Alpha Project",
            folders: ["Projects/Alpha"],
            modelId: "openai/gpt-4o-mini",
            profile: "learning",
            systemPrompt: "Use alpha project terminology.",
            tools: { web: false },
          },
        ],
      };
      await plugin.saveSettings?.();

      const ensureFolder = async (path: string) => {
        if (!app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
      };
      await ensureFolder("Projects");
      await ensureFolder("Projects/Alpha");
      await ensureFolder("Projects/Beta");
      const upsert = async (path: string, body: string) => {
        const existing = app.vault.getAbstractFileByPath(path);
        if (existing instanceof obsidian.TFile) await app.vault.modify(existing, body);
        else await app.vault.create(path, body);
      };
      await upsert(
        "Projects/Alpha/Home.md",
        "# Alpha Home\nSee [[Projects/Alpha/Alpha Related.md]].\nLaunch diagnostics.",
      );
      await upsert("Projects/Alpha/Alpha Related.md", "# Alpha Related\nLaunch diagnostics and alpha decisions.");
      await upsert("Projects/Beta/Beta Related.md", "# Beta Related\nLaunch diagnostics and beta decisions.");
      const file = app.vault.getAbstractFileByPath("Projects/Alpha/Home.md");
      if (!(file instanceof obsidian.TFile)) throw new Error("Alpha home missing");
      await app.workspace.getLeaf(false).openFile(file);
    });

    await runSlashCommand("/project alpha");
    await expect($(".agentic-chat-project-pill")).toHaveText(/Alpha Project/);

    await runSlashCommand("/status");
    const status = await latestInfoText();
    expect(status).toContain("Alpha Project");
    expect(status).toContain("Projects/Alpha");
    expect(status).toContain("openai/gpt-4o-mini");

    const panel = await $(".agentic-chat-relevant-notes");
    await panel.waitForDisplayed();
    await browser.waitUntil(
      async () => {
        const text = await panel.getText();
        return text.includes("Alpha Related.md") && !text.includes("Beta Related.md");
      },
      { timeout: 5_000, timeoutMsg: "project-scoped related notes did not stay inside Projects/Alpha" },
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
    // Dynamic effort (shipped this batch): the knob only offers levels the active
    // model supports. The rendered value must be a member of the canonical set.
    const knob = await $(".agentic-chat-effort");
    await knob.waitForExist();
    await expect($(".agentic-chat-effort-label")).toHaveText(/effort/i);
    const readEffortValue = async (): Promise<string> =>
      browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-effort-value")?.innerText.trim() ?? "");
    const value = await readEffortValue();
    const KNOWN_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
    if (!KNOWN_LEVELS.includes(value)) {
      throw new Error(`effort knob rendered an unknown level: "${value}"`);
    }
    // Cycling must keep it within the supported set (no crash, no invalid level).
    await knob.click();
    const next = await readEffortValue();
    if (!KNOWN_LEVELS.includes(next)) {
      throw new Error(`effort knob cycled to an unknown level: "${next}"`);
    }
  });

  it("tracks a long-run plan item with tests and a checkpoint commit", async function () {
    await runSlashCommand("/todo add Milestone 20 plan tracker");
    const panel = await $(".agentic-chat-plan-tracker");
    await panel.waitForDisplayed();
    await expect(panel).toHaveText(/Milestone 20 plan tracker/);

    await runSlashCommand("/todo set 1 active");
    await runSlashCommand("/todo test 1 passed");
    await runSlashCommand("/todo commit 1 abc1234");

    await browser.waitUntil(
      async () => {
        const text = await panel.getText();
        return text.includes("in progress") && text.includes("tests passed") && text.includes("commit abc1234");
      },
      { timeout: 5_000, timeoutMsg: "plan tracker panel did not show status, tests, and checkpoint commit" },
    );

    const persisted = await browser.executeObsidian(async ({ app }) => {
      const sessionDir = `${app.vault.configDir}/plugins/agentic-chat/sessions`;
      const listing = await app.vault.adapter.list(sessionDir);
      const latest = listing.files.filter((path) => path.endsWith(".jsonl")).sort().at(-1);
      if (!latest) throw new Error("No agentic-chat session file found");
      return await app.vault.adapter.read(latest);
    });
    expect(persisted).toContain('"type":"plan_tracker"');
    expect(persisted).toContain('"checkpointCommit":"abc1234"');
  });

  it("applies a Quick Ask edit to selected editor text without a model call", async function () {
    const path = "Notes/Quick Ask.md";
    await browser.executeObsidian(async ({ app, obsidian }, notePath) => {
      if (!app.vault.getAbstractFileByPath("Notes")) await app.vault.createFolder("Notes");
      const existing = app.vault.getAbstractFileByPath(notePath);
      const body = "quick ask edit";
      const file = existing instanceof obsidian.TFile ? existing : await app.vault.create(notePath, body);
      if (existing instanceof obsidian.TFile) await app.vault.modify(existing, body);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(file);
      app.workspace.setActiveLeaf(leaf, { focus: true });
      const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
      if (!view) throw new Error("Markdown view did not open");
      await view.setState({ mode: "source", source: false }, { history: false });
      view.editor.focus();
      view.editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 5 });
    }, path);
    await browser.waitUntil(
      async () =>
        browser.executeObsidian(async ({ app, obsidian }) => {
          const view = app.workspace.getActiveViewOfType(obsidian.MarkdownView);
          return view instanceof obsidian.MarkdownView && view.editor.getSelection() === "quick";
        }),
      { timeout: 5_000, timeoutMsg: "Quick Ask selection was not ready" },
    );

    await browser.executeObsidianCommand("agentic-chat:quick-ask-inline-edit");
    const modal = await $(".agentic-chat-quick-ask");
    await modal.waitForExist();
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
      const actual = await browser.executeObsidian(async ({ app, obsidian }, notePath) => {
        const file = app.vault.getAbstractFileByPath(notePath);
        if (!(file instanceof obsidian.TFile)) return null;
        return (await app.vault.cachedRead(file)).slice(0, 40);
      }, path);
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; expected prefix ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
  });
});
