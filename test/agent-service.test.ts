import { describe, expect, it } from "vitest";
import { TFile, TFolder, type App } from "obsidian";
import type { AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentService } from "../src/agent/agent-service";
import type { AskUserHandler, AskUserRequest } from "../src/tools/ask-user-tool";
import { isSummaryMessage } from "../src/agent/compaction";
import { ObsidianSessionManager } from "../src/session/session-manager";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { parseSessionEntries } from "../src/session/jsonl";
import { MemoryAdapter } from "./helpers/memory-adapter";
import { FakeVault } from "./helpers/fake-vault";

/** Stream function that returns a fixed assistant reply without any network. */
function cannedStreamFn(text: string): StreamFn {
  return ((model: Model<"openai-completions">) => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 5,
        output: 7,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  }) as unknown as StreamFn;
}

/** Stream function that scripts one assistant message per agent turn. */
function scriptedStreamFn(
  turns: Array<{ content: AssistantMessage["content"]; stopReason: "stop" | "toolUse" }>,
): StreamFn {
  let turn = 0;
  return ((model: Model<"openai-completions">) => {
    const stream = createAssistantMessageEventStream();
    const spec = turns[Math.min(turn, turns.length - 1)];
    turn += 1;
    const message = {
      role: "assistant" as const,
      content: spec.content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: spec.stopReason,
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: spec.stopReason, message });
      stream.end(message);
    });
    return stream;
  }) as unknown as StreamFn;
}

/** Scripts one assistant message per turn, each carrying a USD cost. */
function scriptedCostStreamFn(
  turns: Array<{ content: AssistantMessage["content"]; stopReason: "stop" | "toolUse"; costTotal: number }>,
): StreamFn {
  let turn = 0;
  return ((model: Model<"openai-completions">) => {
    const stream = createAssistantMessageEventStream();
    const spec = turns[Math.min(turn, turns.length - 1)];
    turn += 1;
    const message = {
      role: "assistant" as const,
      content: spec.content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: spec.costTotal },
      },
      stopReason: spec.stopReason,
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: spec.stopReason, message });
      stream.end(message);
    });
    return stream;
  }) as unknown as StreamFn;
}

function makeService(
  streamFn: StreamFn,
  confirmToolCall: () => Promise<boolean> = async () => true,
  app: App = minimalApp(),
  askUser?: AskUserHandler,
): { service: AgentService; adapter: MemoryAdapter; settings: AgenticChatSettings } {
  const settings: AgenticChatSettings = { ...DEFAULT_SETTINGS, openrouterApiKey: "test-key" };
  const adapter = new MemoryAdapter();
  const sessionManager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
  const service = new AgentService({
    app,
    getSettings: () => settings,
    sessionManager,
    confirmToolCall,
    askUser,
    streamFn,
  });
  return { service, adapter, settings };
}

function minimalApp(): App {
  return { vault: { on: () => ({}), offref: () => {} }, workspace: {} } as unknown as App;
}

function vaultBackedApp(): { app: App; vault: FakeVault } {
  const vault = new FakeVault() as FakeVault & {
    getFolderByPath: (path: string) => TFolder | null;
    on: () => Record<string, never>;
    offref: () => void;
  };
  vault.getFolderByPath = (path) => {
    const entry = vault.getAbstractFileByPath(path);
    return entry instanceof TFolder ? entry : null;
  };
  vault.on = () => ({});
  vault.offref = () => {};
  return {
    app: {
      vault,
      workspace: {},
      fileManager: {
        trashFile: async (file: TFile) => vault.trash(file),
      },
    } as unknown as App,
    vault,
  };
}

describe("AgentService", () => {
  it("runs a prompt, exposes the transcript, and tracks usage", async () => {
    const { service } = makeService(cannedStreamFn("Hello from the agent."));
    await service.sendPrompt("Say hello");

    const roles = service.getMessages().map((message) => message.role);
    expect(roles).toEqual(["user", "assistant"]);
    expect(service.getSessionUsage().totalTokens).toBe(12);
    expect(service.getError()).toBeUndefined();
    expect(service.isStreaming()).toBe(false);
  });

  it("applies a one-shot model override to the next prompt only, then reverts", async () => {
    const seen: string[] = [];
    const base = cannedStreamFn("ok");
    const streamFn: StreamFn = ((model: Model<"openai-completions">, context: unknown, options: unknown) => {
      seen.push(model.id);
      return (base as (...args: unknown[]) => unknown)(model, context, options);
    }) as unknown as StreamFn;
    const { service, settings } = makeService(streamFn);

    service.setModelOverride("anthropic/claude-3.5-sonnet");
    expect(service.getModelOverride()).toBe("anthropic/claude-3.5-sonnet");
    expect(service.getActiveModelId()).toBe("anthropic/claude-3.5-sonnet");
    await service.sendPrompt("first");
    // The override was consumed by the turn it was set for.
    expect(service.getModelOverride()).toBeNull();
    expect(service.getActiveModelId()).toBe(settings.openrouterModel);

    await service.sendPrompt("second");
    expect(seen).toEqual(["anthropic/claude-3.5-sonnet", settings.openrouterModel]);
  });

  it("applies a one-shot thinking override to the next prompt only, then reverts", async () => {
    const { service, settings } = makeService(cannedStreamFn("ok"));
    expect(service.getActiveThinkingLevel()).toBe(settings.thinkingLevel);

    service.setThinkingOverride("high");
    expect(service.getThinkingOverride()).toBe("high");
    expect(service.getActiveThinkingLevel()).toBe("high");

    await service.sendPrompt("one hard prompt");
    // The override was consumed by the turn it was set for.
    expect(service.getThinkingOverride()).toBeNull();
    expect(service.getActiveThinkingLevel()).toBe(settings.thinkingLevel);
  });

  it("keeps two tab services over one sessions dir independent", async () => {
    // Mirrors the C3 tab model: each tab is its own AgentService with its own
    // session manager, but they share the plugin's sessions directory.
    const adapter = new MemoryAdapter();
    const settings: AgenticChatSettings = { ...DEFAULT_SETTINGS, openrouterApiKey: "test-key" };
    const makeTab = () =>
      new AgentService({
        app: { vault: { on: () => ({}), offref: () => {} }, workspace: {} } as unknown as App,
        getSettings: () => settings,
        sessionManager: new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test"),
        confirmToolCall: async () => true,
        streamFn: cannedStreamFn("reply"),
      });

    const tab1 = makeTab();
    await tab1.sendPrompt("first tab message");

    const tab2 = makeTab();
    await tab2.newSession(); // a new tab is always a fresh session, not a continuation
    await tab2.sendPrompt("second tab message");

    // Two distinct session files, each holding only its own conversation.
    const files = [...adapter.files.keys()].filter((path) => path.endsWith(".jsonl"));
    expect(files.length).toBe(2);
    const contents = files.map((path) => adapter.files.get(path) as string);
    expect(contents.some((c) => c.includes("first tab message") && !c.includes("second tab message"))).toBe(true);
    expect(contents.some((c) => c.includes("second tab message") && !c.includes("first tab message"))).toBe(true);
    expect(tab1.getMessages().map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(tab2.getMessages().map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("persists the conversation to a JSONL session file", async () => {
    const { service, adapter } = makeService(cannedStreamFn("Persisted reply."));
    await service.sendPrompt("Remember this");

    const sessionFile = [...adapter.files.keys()].find((path) => path.endsWith(".jsonl"));
    expect(sessionFile).toBeDefined();
    const entries = parseSessionEntries(adapter.files.get(sessionFile as string) as string);
    const messageEntries = entries.filter((entry) => entry.type === "message");
    expect(messageEntries).toHaveLength(2);
  });

  it("initialize continues the most recent persisted session", async () => {
    const first = makeService(cannedStreamFn("Persisted first reply."));
    await first.service.sendPrompt("first persisted prompt");
    const firstPath = first.service.getSessionInfo()?.path;
    expect(firstPath).toBeDefined();

    const secondSessionManager = new ObsidianSessionManager(first.adapter.asDataAdapter(), "sessions", "vault:test");
    const second = new AgentService({
      app: minimalApp(),
      getSettings: () => first.settings,
      sessionManager: secondSessionManager,
      confirmToolCall: async () => true,
      streamFn: cannedStreamFn("unused"),
    });

    await second.initialize();
    expect(second.getSessionInfo()?.path).toBe(firstPath);
    expect(second.getMessages().map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(second.getMessages().some((message) => JSON.stringify(message).includes("first persisted prompt"))).toBe(true);
  });

  it("refreshes resources and tool registration before each prompt", async () => {
    const seenTools: string[][] = [];
    const base = cannedStreamFn("ok");
    const streamFn: StreamFn = ((model: Model<"openai-completions">, context: Context, options: unknown) => {
      seenTools.push((context.tools ?? []).map((tool) => tool.name).sort());
      return (base as (...args: unknown[]) => unknown)(model, context, options);
    }) as unknown as StreamFn;
    const { service, settings } = makeService(streamFn);

    settings.web = { ...settings.web, enabled: false };
    await service.sendPrompt("without web");
    settings.web = { ...settings.web, enabled: true };
    await service.sendPrompt("with web");

    expect(seenTools[0]).not.toContain("web_search");
    expect(seenTools[0]).not.toContain("fetch_url");
    expect(seenTools[1]).toContain("web_search");
    expect(seenTools[1]).toContain("fetch_url");
  });

  it("runs ask_user through the registered UI handler and continues", async () => {
    const streamFn = scriptedStreamFn([
      {
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "ask_user",
            arguments: { question: "Which folder should I use?", choices: ["Notes", "Archive"] },
          },
        ],
        stopReason: "toolUse",
      },
      { content: [{ type: "text", text: "I will use Notes." }], stopReason: "stop" },
    ]);
    let asked: AskUserRequest | undefined;
    const { service } = makeService(streamFn, async () => true, minimalApp(), async (request) => {
      asked = request;
      return "Notes";
    });

    await service.sendPrompt("Organize this note");

    expect(asked).toEqual({ question: "Which folder should I use?", choices: ["Notes", "Archive"] });
    const toolResult = service.getMessages().find((message) => message.role === "toolResult") as
      | { role: "toolResult"; isError: boolean; content: Array<{ type: string; text?: string }> }
      | undefined;
    expect(toolResult?.isError).toBe(false);
    expect((toolResult?.content ?? []).map((block) => block.text ?? "").join("")).toContain("User answered: Notes");
    expect(service.getMessages().filter((message) => message.role === "assistant")).toHaveLength(2);
  });

  it("clears session-local undo state when starting a new session", async () => {
    const { app, vault } = vaultBackedApp();
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "Undo/New.md", content: "created" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Wrote it." }], stopReason: "stop" },
    ]);
    const { service } = makeService(streamFn, async () => true, app);

    await service.sendPrompt("create undoable note");
    expect(vault.contentOf("Undo/New.md")).toBe("created");
    expect(service.canUndo()).toBe(true);

    await service.newSession();
    expect(service.canUndo()).toBe(false);
    expect(await service.undoLastChange()).toBe("Nothing to undo.");
  });

  it("clears session-local state when loading another session", async () => {
    const { app, vault } = vaultBackedApp();
    const streamFn = scriptedStreamFn([
      { content: [{ type: "text", text: "First session reply." }], stopReason: "stop" },
      { content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "Undo/Load.md", content: "created" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Wrote it." }], stopReason: "stop" },
    ]);
    const { service, adapter } = makeService(streamFn, async () => true, app);

    await service.sendPrompt("keep this session");
    const firstPath = service.getSessionInfo()?.path as string;
    expect(parseSessionEntries(adapter.files.get(firstPath) as string).filter((entry) => entry.type === "message")).toHaveLength(2);

    await service.newSession();
    await service.sendPrompt("create undoable note before loading");
    expect(vault.contentOf("Undo/Load.md")).toBe("created");
    expect(service.canUndo()).toBe(true);

    await service.loadSession(firstPath);
    expect(service.getMessages().some((message) => JSON.stringify(message).includes("keep this session"))).toBe(true);
    expect(service.canUndo()).toBe(false);
    expect(await service.undoLastChange()).toBe("Nothing to undo.");

    await service.sendPrompt("continue loaded session");
    const messageEntries = parseSessionEntries(adapter.files.get(firstPath) as string).filter((entry) => entry.type === "message");
    expect(messageEntries).toHaveLength(4);
    expect(messageEntries.filter((entry) => JSON.stringify(entry.message).includes("keep this session"))).toHaveLength(1);
  });

  it("clears session-local undo state when truncating messages", async () => {
    const { app, vault } = vaultBackedApp();
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "Undo/Rewind.md", content: "created" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Wrote it." }], stopReason: "stop" },
    ]);
    const { service } = makeService(streamFn, async () => true, app);

    await service.sendPrompt("create undoable note");
    expect(vault.contentOf("Undo/Rewind.md")).toBe("created");
    expect(service.canUndo()).toBe(true);

    await service.truncateMessages(1);
    expect(service.getMessages().map((message) => message.role)).toEqual(["user"]);
    expect(service.canUndo()).toBe(false);
    expect(await service.undoLastChange()).toBe("Nothing to undo.");
  });

  it("sends a denial result back to the model when the user declines a tool call", async () => {
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "note.md", content: "hi" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Understood, I won't write it." }], stopReason: "stop" },
    ]);
    const { service } = makeService(streamFn, async () => false);
    await service.sendPrompt("Create note.md");

    const messages = service.getMessages();
    const toolResult = messages.find((message) => message.role === "toolResult") as
      | { role: "toolResult"; isError: boolean; content: Array<{ type: string; text?: string }> }
      | undefined;
    expect(toolResult).toBeDefined();
    expect(toolResult?.isError).toBe(true);
    const resultText = (toolResult?.content ?? []).map((block) => block.text ?? "").join("");
    expect(resultText).toMatch(/declined/i);
    // The model received the denial and produced a follow-up turn.
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(2);
  });

  it("blocks mutating tools in plan mode and feeds the read-only denial back to the model", async () => {
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "note.md", content: "hi" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Read-only — here's what I would write." }], stopReason: "stop" },
    ]);
    // Approval allows mutating and the user would confirm — plan mode must still block.
    const { service, settings } = makeService(streamFn, async () => true);
    settings.mode = "plan";
    settings.approval = { mutating: "allow", perTool: {}, workingDirs: [] };
    await service.sendPrompt("Create note.md");

    const toolResult = service.getMessages().find((message) => message.role === "toolResult") as
      | { role: "toolResult"; isError: boolean; content: Array<{ type: string; text?: string }> }
      | undefined;
    expect(toolResult?.isError).toBe(true);
    const resultText = (toolResult?.content ?? []).map((block) => block.text ?? "").join("");
    expect(resultText).toMatch(/read-only/i);
  });

  it("yolo mode auto-approves mutating tools, but an explicit per-tool deny still wins", async () => {
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "note.md", content: "hi" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Understood, write is off-limits." }], stopReason: "stop" },
    ]);
    // YOLO forces mutating→allow, but the per-tool deny on `write` must override it,
    // and never prompt the user even though confirmToolCall would say yes.
    const { service, settings } = makeService(streamFn, async () => true);
    settings.mode = "yolo";
    settings.approval = { mutating: "allow", perTool: { write: "deny" }, workingDirs: [] };
    await service.sendPrompt("Create note.md");

    const toolResult = service.getMessages().find((message) => message.role === "toolResult") as
      | { role: "toolResult"; isError: boolean; content: Array<{ type: string; text?: string }> }
      | undefined;
    expect(toolResult?.isError).toBe(true);
    const resultText = (toolResult?.content ?? []).map((block) => block.text ?? "").join("");
    expect(resultText).toMatch(/disabled by your approval settings|declined/i);
    // The model received the denial and produced a follow-up turn.
    expect(service.getMessages().filter((message) => message.role === "assistant")).toHaveLength(2);
  });

  it("safe-mode working-dir boundary routes out-of-scope mutations through ask", async () => {
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "Other/x.md", content: "hi" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Ok, leaving it." }], stopReason: "stop" },
    ]);
    let confirmCalls = 0;
    const { service, settings } = makeService(streamFn, async () => {
      confirmCalls += 1;
      return false;
    });
    settings.mode = "safe";
    // Even with mutating set to allow, a target outside the working set must prompt.
    settings.approval = { mutating: "allow", perTool: {}, workingDirs: ["Notes"] };
    await service.sendPrompt("write outside");
    expect(confirmCalls).toBe(1);
  });

  it("safe-mode working-dir boundary auto-runs mutations inside the granted dir", async () => {
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "Notes/x.md", content: "hi" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Wrote it." }], stopReason: "stop" },
    ]);
    let confirmCalls = 0;
    const { service, settings } = makeService(streamFn, async () => {
      confirmCalls += 1;
      return true;
    });
    settings.mode = "safe";
    // Default mutating "ask" is overridden to auto-run because the target is in-scope.
    settings.approval = { mutating: "ask", perTool: {}, workingDirs: ["Notes"] };
    await service.sendPrompt("write inside");
    expect(confirmCalls).toBe(0);
  });

  it("safe-mode working-dir boundary asks before reading outside the granted dir", async () => {
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "Other/x.md" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Ok." }], stopReason: "stop" },
    ]);
    let confirmCalls = 0;
    const { service, settings } = makeService(streamFn, async () => {
      confirmCalls += 1;
      return false;
    });
    settings.mode = "safe";
    // A read is normally free, but with a working set configured an out-of-scope read asks (S2).
    settings.approval = { mutating: "ask", perTool: {}, workingDirs: ["Notes"] };
    await service.sendPrompt("read outside");
    expect(confirmCalls).toBe(1);
  });

  it("dispatches a subagent, folds child usage into the session, and exposes profiles", async () => {
    const streamFn = scriptedStreamFn([
      // Parent turn 1: ask to dispatch the researcher subagent.
      { content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { agent: "researcher", task: "summarize the inbox" } }], stopReason: "toolUse" },
      // Child turn: the researcher's reply (same injected stream serves the child).
      { content: [{ type: "text", text: "Inbox has 3 open threads." }], stopReason: "stop" },
      // Parent turn 2: final answer after the subagent returns.
      { content: [{ type: "text", text: "All done." }], stopReason: "stop" },
    ]);
    const { service } = makeService(streamFn);
    await service.sendPrompt("Use a subagent to check my inbox");

    expect(service.getProfiles().map((profile) => profile.name)).toContain("researcher");
    const toolResult = service.getMessages().find((message) => message.role === "toolResult") as
      | { role: "toolResult"; isError: boolean; content: Array<{ type: string; text?: string }> }
      | undefined;
    expect(toolResult?.isError).toBe(false);
    const resultText = (toolResult?.content ?? []).map((block) => block.text ?? "").join("");
    expect(resultText).toContain("Inbox has 3 open threads.");
    // Parent's two assistant turns (2 + 2) plus the child's folded-in usage (2).
    expect(service.getSessionUsage().totalTokens).toBe(6);
  });

  it("confirms a subagent dispatch when a working set is configured (children bypass the path boundary)", async () => {
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "call-1", name: "subagent", arguments: { agent: "researcher", task: "summarize" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Ok, not dispatching." }], stopReason: "stop" },
    ]);
    let confirmCalls = 0;
    const { service, settings } = makeService(streamFn, async () => {
      confirmCalls += 1;
      return false;
    });
    settings.mode = "safe";
    // A read-only research fan-out normally wouldn't prompt, but with a working set the
    // children can't be path-constrained, so the dispatch must be confirmed up front.
    settings.approval = { mutating: "ask", perTool: {}, workingDirs: ["Notes"] };
    await service.sendPrompt("research with a subagent");
    expect(confirmCalls).toBe(1);
  });

  it("exposes the deep-research skill only when web access is enabled", async () => {
    const off = makeService(cannedStreamFn("hi"));
    await off.service.initialize();
    expect(off.service.getSkills().map((skill) => skill.name)).not.toContain("deep-research");

    const on = makeService(cannedStreamFn("hi"));
    on.settings.web = { ...on.settings.web, enabled: true };
    await on.service.initialize();
    expect(on.service.getSkills().map((skill) => skill.name)).toContain("deep-research");
  });

  it("lists available subagents (and hints a skill) for an unknown /agent name", async () => {
    const { service, settings } = makeService(cannedStreamFn("unused"));
    settings.web = { ...settings.web, enabled: true }; // load the deep-research skill
    await service.initialize();

    await service.invokeAgent("deep", "do some research");
    const error = service.getError() ?? "";
    expect(error).toContain('No subagent named "deep"');
    expect(error).toContain("researcher"); // available built-in profiles are listed
    expect(error).toMatch(/deep-research/); // "deep" is hinted as the deep-research skill
  });

  it("auto-compacts old turns once the context window fills, preserving usage", async () => {
    // Each assistant turn reports ~110k context tokens — over 80% of the synthesized
    // 128k window — so the third send triggers compaction of the first turn.
    const bigUsageStream: StreamFn = ((model: Model<"openai-completions">) => {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "ok" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 110_000,
          output: 100,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 110_100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    }) as unknown as StreamFn;

    const settings: AgenticChatSettings = {
      ...DEFAULT_SETTINGS,
      openrouterApiKey: "test-key",
      // An id absent from pi's catalog → synthesized model with the default 128k window.
      openrouterModel: "test/compaction-model",
    };
    const adapter = new MemoryAdapter();
    const sessionManager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
    let summarizeCalls = 0;
    const service = new AgentService({
      app: { vault: { on: () => ({}), offref: () => {} }, workspace: {} } as unknown as App,
      getSettings: () => settings,
      sessionManager,
      confirmToolCall: async () => true,
      streamFn: bigUsageStream,
      summarize: async () => {
        summarizeCalls += 1;
        return "Summary of earlier turns.";
      },
    });

    await service.sendPrompt("first");
    await service.sendPrompt("second");
    expect(service.getCompactionCount()).toBe(0); // only one user turn behind us so far

    await service.sendPrompt("third"); // maybeCompact runs before this prompt
    expect(summarizeCalls).toBe(1);
    expect(service.getCompactionCount()).toBe(1);

    const messages = service.getMessages();
    expect(isSummaryMessage(messages[0])).toBe(true);
    // The first turn was folded into the summary, not left verbatim.
    expect(messages.some((m) => JSON.stringify(m).includes('"first"'))).toBe(false);
    // 3 turns × 110_100 totalTokens, with the dropped turn folded into the session total.
    expect(service.getSessionUsage().totalTokens).toBe(330_300);

    // The compacted usage is carried on the summary message, so reloading the
    // session from disk into a fresh service preserves the total and the count.
    const path = service.getSessionInfo()?.path as string;
    const reloaded = new AgentService({
      app: { vault: { on: () => ({}), offref: () => {} }, workspace: {} } as unknown as App,
      getSettings: () => settings,
      sessionManager: new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test"),
      confirmToolCall: async () => true,
      streamFn: bigUsageStream,
      summarize: async () => "unused",
    });
    await reloaded.loadSession(path);
    expect(reloaded.getCompactionCount()).toBe(1);
    expect(reloaded.getSessionUsage().totalTokens).toBe(330_300);
  });

  it("blocks new turns once the hard spend cap is reached", async () => {
    const costStream: StreamFn = ((model: Model<"openai-completions">) => {
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "ok" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 100,
          output: 50,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 150,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
        },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
      return stream;
    }) as unknown as StreamFn;

    const { service, settings } = makeService(costStream);
    settings.notifications.costCapUsd = 0.01;

    await service.sendPrompt("one"); // allowed: cost is 0 at send time
    expect(service.getSessionUsage().cost?.total).toBeCloseTo(0.02, 6);

    await service.sendPrompt("two"); // blocked: 0.02 already ≥ 0.01 cap
    expect(service.getError()).toMatch(/spend cap/i);
    // The blocked prompt never ran, so only the first turn's two messages exist.
    expect(service.getMessages().map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("aborts an in-flight turn once the running turn crosses the spend cap", async () => {
    // Turn 1 is a tool call that already costs 0.02 (> the 0.01 cap); the loop
    // must abort after that turn instead of proceeding to a second turn.
    const stream = scriptedCostStreamFn([
      { content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "n.md", content: "x" } }], stopReason: "toolUse", costTotal: 0.02 },
      { content: [{ type: "text", text: "should not run" }], stopReason: "stop", costTotal: 0.02 },
    ]);
    const { service, settings } = makeService(stream, async () => true);
    settings.notifications.costCapUsd = 0.01;

    await service.sendPrompt("go"); // cost is 0 at send time, so the turn starts
    // The "stopped this turn" wording is only produced by the in-flight
    // enforceSpendCap path (the pre-send block uses different wording), so this
    // proves the cap fired mid-run and aborted the agent.
    expect(service.getError()).toMatch(/stopped this turn/i);
  });

  it("records prompt run errors and consumes overrides for the attempted turn", async () => {
    const failingStream: StreamFn = (() => {
      throw new Error("stream failed");
    }) as unknown as StreamFn;
    const { service, settings } = makeService(failingStream);

    service.setModelOverride("anthropic/claude-3.5-sonnet");
    service.setThinkingOverride("high");
    await service.sendPrompt("fail");

    expect(service.getError()).toBe("stream failed");
    expect(service.getModelOverride()).toBeNull();
    expect(service.getActiveModelId()).toBe(settings.openrouterModel);
    expect(service.getThinkingOverride()).toBeNull();
    expect(service.getActiveThinkingLevel()).toBe(settings.thinkingLevel);
  });

  it("reports a friendly error when no API key is configured", async () => {
    const { service, settings } = makeService(cannedStreamFn("unused"));
    settings.openrouterApiKey = "";
    service.setModelOverride("anthropic/claude-3.5-sonnet");

    await service.sendPrompt("Hi");

    expect(service.getError()).toMatch(/API key/);
    expect(service.getMessages()).toHaveLength(0);
    expect(service.getModelOverride()).toBe("anthropic/claude-3.5-sonnet");
  });
});
