import { browser, expect, $ } from "@wdio/globals";
import { afterEach, before, describe, it } from "mocha";

const VIEW_TYPE_AGENT_CHAT = "agentic-chat-chat-view";
const PRIVATE_NOTE_PATH = "Private/Secret.md";
const PRIVATE_NOTE_BODY = "PRIVATE E2E SECRET: ignored active note body must not leak.";

async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

async function runSlashCommand(command: string): Promise<void> {
  const input = await $(".agentic-chat-input");
  await input.click();
  await input.setValue(command);
  await $(".agentic-chat-send").click();
}

async function sendPrompt(prompt: string): Promise<void> {
  const input = await $(".agentic-chat-input");
  await input.click();
  await input.setValue(prompt);
  await $(".agentic-chat-send").click();
}

async function closeOpenModals(): Promise<void> {
  await browser.execute(() => {
    for (const close of Array.from(document.querySelectorAll<HTMLElement>(".modal-close-button"))) close.click();
    for (const backdrop of Array.from(document.querySelectorAll<HTMLElement>(".modal-bg"))) backdrop.click();
  });
  await browser
    .waitUntil(
      async () => await browser.execute(() => document.querySelectorAll(".modal-bg").length === 0),
      { timeout: 1_000 },
    )
    .catch(() => undefined);
}

async function latestInfoText(): Promise<string> {
  await $(".agentic-chat-info").waitForExist();
  return await browser.execute(() => {
    const infos = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-info"));
    return infos.at(-1)?.innerText ?? "";
  });
}

async function seedRuntimeState(): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }, privateNote) => {
    const plugin = (app as unknown as {
      plugins?: {
        plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }>;
      };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");

    const settings = plugin.settings as {
      provider: string;
      openrouterApiKey: string;
      ignoredGlobs: string;
      web: { enabled: boolean };
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = "";
    settings.ignoredGlobs = "Private/";
    settings.web.enabled = true;
    await plugin.saveSettings?.();

    if (!app.vault.getAbstractFileByPath("Private")) await app.vault.createFolder("Private");
    const privateFile = app.vault.getAbstractFileByPath(privateNote.path);
    if (privateFile instanceof obsidian.TFile) await app.vault.modify(privateFile, privateNote.body);
    else await app.vault.create(privateNote.path, privateNote.body);

    const adapter = app.vault.adapter as unknown as {
      list: (path: string) => Promise<{ files: string[]; folders: string[] }>;
      mkdir: (path: string) => Promise<void>;
      remove: (path: string) => Promise<void>;
      write: (path: string, data: string) => Promise<void>;
    };
    const sessionsDir = `${app.vault.configDir}/plugins/agentic-chat/sessions`;
    try {
      const listing = await adapter.list(sessionsDir);
      await Promise.all(listing.files.filter((file) => file.endsWith(".jsonl")).map((file) => adapter.remove(file)));
    } catch {
      await adapter.mkdir(sessionsDir);
    }

    const cwd = `obsidian-vault:${app.vault.getName()}`;
    const userMessage = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
    const assistantMessage = (text: string) => ({
      role: "assistant",
      content: [{ type: "text", text }],
      provider: "openrouter",
      model: "openai/gpt-4o-mini",
      timestamp: 1,
    });
    const sessionJsonl = (id: string, name: string, firstPrompt: string, assistantText: string, timestamp: string) => {
      const entries = [
        { type: "session", version: 1, id, timestamp, cwd },
        { type: "model_change", id: `${id}-model`, parentId: null, timestamp, provider: "openrouter", modelId: "openai/gpt-4o-mini" },
        { type: "thinking_level_change", id: `${id}-think`, parentId: `${id}-model`, timestamp, thinkingLevel: "off" },
        { type: "message", id: `${id}-user`, parentId: `${id}-think`, timestamp, message: userMessage(firstPrompt) },
        { type: "message", id: `${id}-assistant`, parentId: `${id}-user`, timestamp, message: assistantMessage(assistantText) },
        { type: "session_info", id: `${id}-name`, parentId: `${id}-assistant`, timestamp, name },
      ];
      return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    };

    await adapter.write(
      `${sessionsDir}/2026-06-23T00-00-00-000Z_alpha.jsonl`,
      sessionJsonl("alpha", "Alpha Conversation", "alpha seeded prompt", "alpha seeded answer", "2026-06-23T00:00:00.000Z"),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    await adapter.write(
      `${sessionsDir}/2026-06-23T00-01-00-000Z_beta.jsonl`,
      sessionJsonl(
        "beta",
        "Beta Conversation",
        "beta seeded prompt",
        Array.from({ length: 20 }, (_, index) => `beta seeded answer line ${index + 1}`).join("\n\n"),
        "2026-06-23T00:01:00.000Z",
      ),
    );

    const file = app.vault.getAbstractFileByPath(privateNote.path);
    if (file instanceof obsidian.TFile) await app.workspace.getLeaf(false).openFile(file);
  }, { path: PRIVATE_NOTE_PATH, body: PRIVATE_NOTE_BODY });
}

async function searchSessions(query: string): Promise<void> {
  await runSlashCommand("/sessions");
  await $(".agentic-chat-session-list").waitForExist();
  const search = await $(".agentic-chat-session-search");
  await search.setValue(query);
  await browser.waitUntil(
    async () =>
      await browser.execute((searchQuery) => {
        const rows = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-session-row"));
        return rows.length === 1 && rows[0].innerText.includes(searchQuery);
      }, query),
    { timeout: 5_000, timeoutMsg: `session search did not narrow to ${query}` },
  );
}

async function transcriptIsPinned(): Promise<boolean> {
  return await browser.execute(() => {
    const el = document.querySelector<HTMLElement>(".agentic-chat-messages");
    if (!el) return false;
    return el.scrollHeight <= el.clientHeight || el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
  });
}

describe("agentic-chat runtime behavior", function () {
  before(async function () {
    await seedRuntimeState();
    await openChat();
  });

  afterEach(async function () {
    await closeOpenModals();
  });

  it("reopens, renames, and deletes persisted sessions without a model call", async function () {
    await expect($(".agentic-chat-messages")).toHaveText(/beta seeded answer line 20/);
    expect(await transcriptIsPinned()).toBe(true);

    await searchSessions("Alpha");
    await browser.execute((nextName) => {
      const rename = document.querySelector<HTMLButtonElement>(".agentic-chat-session-row .agentic-chat-session-rename");
      if (!rename) throw new Error("session rename button not found");
      rename.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      rename.click();
      const input = document.querySelector<HTMLInputElement>(".agentic-chat-session-rename-input");
      if (!input) throw new Error("session rename input not created");
      input.value = nextName;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }, "Renamed Alpha Conversation");
    await browser.waitUntil(
      async () => (await $(".agentic-chat-session-row").getText()).includes("Renamed Alpha Conversation"),
      { timeout: 5_000, timeoutMsg: "session rename did not render" },
    );

    await $(".agentic-chat-session-row .agentic-chat-session-main").click();
    await expect($(".agentic-chat-messages")).toHaveText(/alpha seeded answer/);

    await searchSessions("Renamed Alpha");
    await $(".agentic-chat-session-row .agentic-chat-session-delete").click();
    await $(".agentic-chat-session-empty").waitForExist();
    await expect($(".agentic-chat-session-empty")).toHaveText(/No conversations match your search/);
    await closeOpenModals();
  });

  it("does not auto-attach an ignored active note", async function () {
    await browser.executeObsidian(async ({ app, obsidian }, path) => {
      const file = app.vault.getAbstractFileByPath(path);
      if (!(file instanceof obsidian.TFile)) throw new Error(`${path} missing`);
      await app.workspace.getLeaf(false).openFile(file);
    }, PRIVATE_NOTE_PATH);

    await browser.waitUntil(
      async () => await browser.execute(() => document.querySelector(".agentic-chat-chip.is-active-note") == null),
      { timeout: 5_000, timeoutMsg: "ignored active note still rendered an automatic context chip" },
    );

    await sendPrompt("check ignored active note handling");
    await expect($(".agentic-chat-info-error")).toHaveText(/Add a openrouter API key/);

    const prompt = await browser.executeObsidian(async ({ app }, viewType) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
        lastSentPrompt?: string;
      };
      return view?.lastSentPrompt ?? "";
    }, VIEW_TYPE_AGENT_CHAT);
    expect(prompt).not.toContain(PRIVATE_NOTE_PATH);
    expect(prompt).not.toContain("contents are withheld");
    expect(prompt).not.toContain(PRIVATE_NOTE_BODY);
  });

  it("shows model/provider status, local plan/undo state, and web tools when enabled", async function () {
    await runSlashCommand("/status");
    const status = await latestInfoText();
    expect(status).toContain("Provider");
    expect(status).toContain("openrouter");
    expect(status).toContain("Model");

    await runSlashCommand("/plan");
    await expect($(".agentic-chat-plan-badge")).toBeDisplayed();
    await runSlashCommand("/endplan");
    await expect($(".agentic-chat-plan-badge")).not.toBeDisplayed();

    await runSlashCommand("/undo");
    expect(await latestInfoText()).toContain("Nothing to undo.");

    const tools = await browser.executeObsidian(async ({ app }, viewType) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
        service?: { agent?: { state?: { tools?: Array<{ name: string }> } } };
      };
      return view?.service?.agent?.state?.tools?.map((tool) => tool.name) ?? [];
    }, VIEW_TYPE_AGENT_CHAT);
    expect(tools).toContain("web_search");
    expect(tools).toContain("fetch_url");
  });

  it("keeps the composer usable in a narrow viewport and pins streamed text to the bottom", async function () {
    await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".agentic-chat-view");
      if (!view) return;
      view.dataset.e2eWidth = view.style.width;
      view.dataset.e2eMaxWidth = view.style.maxWidth;
      view.style.width = "390px";
      view.style.maxWidth = "390px";
    });
    await expect($(".agentic-chat-input")).toBeDisplayed();
    await expect($(".agentic-chat-send")).toBeDisplayed();
    await expect($(".agentic-chat-model-pill")).toBeDisplayed();

    const pinned = await browser.executeObsidian(async ({ app }, viewType) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
        handleAgentEvent?: (event: unknown) => void;
      };
      if (!view?.handleAgentEvent) return { pinned: false, scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
      const el = document.querySelector<HTMLElement>(".agentic-chat-messages");
      if (!el) return { pinned: false, scrollHeight: 0, clientHeight: 0, scrollTop: 0 };
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll"));
      view.handleAgentEvent({ type: "agent_start" });
      view.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: [] } });
      for (let index = 0; index < 40; index += 1) {
        view.handleAgentEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: `streamed line ${index + 1}\n` },
        });
      }
      view.handleAgentEvent({ type: "agent_end" });
      await new Promise((resolve) =>
        window.requestAnimationFrame(() =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(undefined))),
        ),
      );
      return {
        pinned: el.scrollHeight <= el.clientHeight || el.scrollHeight - el.scrollTop - el.clientHeight <= 4,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollTop: el.scrollTop,
      };
    }, VIEW_TYPE_AGENT_CHAT);
    if (!pinned.pinned) throw new Error(`stream did not stay pinned: ${JSON.stringify(pinned)}`);
    await browser.execute(() => {
      const view = document.querySelector<HTMLElement>(".agentic-chat-view");
      if (!view) return;
      view.style.width = view.dataset.e2eWidth ?? "";
      view.style.maxWidth = view.dataset.e2eMaxWidth ?? "";
      delete view.dataset.e2eWidth;
      delete view.dataset.e2eMaxWidth;
    });
  });

  it("does not force-scroll while the user has scrolled up during streaming", async function () {
    const result = await browser.executeObsidian(async ({ app }, viewType) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
        handleAgentEvent?: (event: unknown) => void;
      };
      const el = document.querySelector<HTMLElement>(".agentic-chat-messages");
      if (!view?.handleAgentEvent || !el) return { overflowed: false, before: -1, after: -1 };

      view.handleAgentEvent({ type: "agent_start" });
      view.handleAgentEvent({ type: "message_start", message: { role: "assistant", content: [] } });
      for (let index = 0; index < 120; index += 1) {
        view.handleAgentEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: `scroll guard seed line ${index + 1}\n` },
        });
      }
      await new Promise((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(undefined))),
      );

      const overflowed = el.scrollHeight > el.clientHeight + 20;
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
      const before = el.scrollTop;

      for (let index = 0; index < 20; index += 1) {
        view.handleAgentEvent({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: `scroll guard live line ${index + 1}\n` },
        });
      }
      await new Promise((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(undefined))),
      );
      const after = el.scrollTop;
      view.handleAgentEvent({ type: "agent_end" });
      return { overflowed, before, after };
    }, VIEW_TYPE_AGENT_CHAT);

    expect(result.overflowed).toBe(true);
    expect(result.after).toBeLessThanOrEqual(result.before + 4);
  });

  it("force-scrolls back to the bottom when the user sends a new prompt", async function () {
    await browser.execute(() => {
      const el = document.querySelector<HTMLElement>(".agentic-chat-messages");
      if (!el) throw new Error("messages pane not found");
      for (let index = 0; index < 80; index += 1) {
        const row = document.createElement("div");
        row.className = "agentic-chat-message agentic-chat-info";
        row.textContent = `scroll seed ${index + 1}`;
        el.appendChild(row);
      }
      el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });

    await sendPrompt("new prompt should repin transcript");

    const pinned = await browser.execute(async () => {
      await new Promise((resolve) =>
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(undefined))),
      );
      const el = document.querySelector<HTMLElement>(".agentic-chat-messages");
      if (!el) return false;
      return el.scrollHeight <= el.clientHeight || el.scrollHeight - el.scrollTop - el.clientHeight <= 4;
    });

    expect(pinned).toBe(true);
  });
});
