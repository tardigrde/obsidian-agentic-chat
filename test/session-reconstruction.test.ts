import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AgentService } from "../src/agent/agent-service";
import { ObsidianSessionManager } from "../src/session/session-manager";
import {
  buildSessionContext,
  getLastLeafId,
  parseSessionEntries,
  type SessionEntry,
} from "../src/session/jsonl";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { MemoryAdapter } from "./helpers/memory-adapter";

/**
 * First-principles tests for session reconstruction (src/session/).
 *
 * Derived from the documented contract (AGENTS.md "Sessions" + JSDoc):
 *   - Entries form a linked list via parentId/leafId; buildSessionContext
 *     reconstructs the message list by walking the parent chain to leafId.
 *   - Each AgentMessage is persisted exactly once (WeakSet de-dupe) on
 *     message_end/agent_end; tool-result messages are persisted too.
 *   - A partial/corrupt append must not lose the rest of the session.
 *
 * Driven through an in-memory MemoryAdapter (no Obsidian, no Node fs).
 */

const DEFAULTS = { provider: "openrouter", modelId: "x/y", thinkingLevel: "off" as const };

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistantMessage(text: string, provider = "openrouter", model = "x/y"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    provider,
    model,
    timestamp: 1,
  } as unknown as AgentMessage;
}

function manager(): { sm: ObsidianSessionManager; adapter: MemoryAdapter } {
  const adapter = new MemoryAdapter();
  const sm = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
  return { sm, adapter };
}

describe("session linked-list invariants", () => {
  it("walks the parent chain to leafId and ignores entries off the active branch", () => {
    // A rewind (prompt edit) forks the chain: m2 and m2b both descend from m1.
    // buildSessionContext must follow only the branch ending at leafId.
    const entries: SessionEntry[] = [
      { type: "session", version: 1, id: "sid", timestamp: "t", cwd: "vault:test" },
      { type: "message", id: "m1", parentId: null, timestamp: "t", message: userMessage("first") },
      { type: "message", id: "m2", parentId: "m1", timestamp: "t", message: userMessage("second") },
      { type: "message", id: "m2b", parentId: "m1", timestamp: "t", message: userMessage("second-prime") },
    ];

    const prime = buildSessionContext(entries, "m2b");
    expect(prime.messages.map((m) => text(m))).toEqual(["first", "second-prime"]);

    const original = buildSessionContext(entries, "m2");
    expect(original.messages.map((m) => text(m))).toEqual(["first", "second"]);
  });

  it("defaults to the last non-header entry when no leafId is given, and yields nothing for null", () => {
    const entries: SessionEntry[] = [
      { type: "session", version: 1, id: "sid", timestamp: "t", cwd: "vault:test" },
      { type: "message", id: "m1", parentId: null, timestamp: "t", message: userMessage("a") },
      { type: "message", id: "m2", parentId: "m1", timestamp: "t", message: userMessage("b") },
    ];
    // No leafId → the last entry is the leaf.
    expect(buildSessionContext(entries).messages.map((m) => text(m))).toEqual(["a", "b"]);
    expect(getLastLeafId(entries)).toBe("m2");
    // Explicit null → empty branch (a brand-new session before any turn).
    expect(buildSessionContext(entries, null).messages).toHaveLength(0);
  });

  it("resolves model and thinking level from the latest change entry on the walked chain only", () => {
    const entries: SessionEntry[] = [
      { type: "session", version: 1, id: "sid", timestamp: "t", cwd: "vault:test" },
      { type: "model_change", id: "c1", parentId: null, timestamp: "t", provider: "openrouter", modelId: "old/model" },
      { type: "thinking_level_change", id: "c2", parentId: "c1", timestamp: "t", thinkingLevel: "low" as ThinkingLevel },
      { type: "model_change", id: "c3", parentId: "c2", timestamp: "t", provider: "openrouter", modelId: "new/model" },
      { type: "thinking_level_change", id: "c4", parentId: "c3", timestamp: "t", thinkingLevel: "high" as ThinkingLevel },
      { type: "message", id: "m1", parentId: "c4", timestamp: "t", message: userMessage("hi") },
      // An off-chain change (a sibling model_change off c2) must NOT affect the active context.
      { type: "model_change", id: "x1", parentId: "c2", timestamp: "t", provider: "openrouter", modelId: "stale/model" },
    ];
    const context = buildSessionContext(entries, "m1");
    expect(context.model).toEqual({ provider: "openrouter", modelId: "new/model" });
    expect(context.thinkingLevel).toBe("high");
  });

  it("derives context.model from an assistant message on the chain", () => {
    const entries: SessionEntry[] = [
      { type: "session", version: 1, id: "sid", timestamp: "t", cwd: "vault:test" },
      { type: "message", id: "m1", parentId: null, timestamp: "t", message: userMessage("hi") },
      { type: "message", id: "m2", parentId: "m1", timestamp: "t", message: assistantMessage("hello", "openrouter", "some/model") },
    ];
    expect(buildSessionContext(entries, "m2").model).toEqual({ provider: "openrouter", modelId: "some/model" });
  });
});

describe("ObsidianSessionManager chaining", () => {
  it("createSession seeds a valid header → model_change → thinking_level_change chain", async () => {
    const { sm, adapter } = manager();
    const info = await sm.createSession(DEFAULTS);
    const entries = parseSessionEntries(adapter.files.get(info.path) ?? "");
    // Documented entry order, each non-header chained to the previous entry.
    expect(entries.map((e) => e.type)).toEqual(["session", "model_change", "thinking_level_change"]);
    const modelChange = entries[1] as { parentId: string | null; id: string };
    const thinkingChange = entries[2] as { parentId: string | null; id: string };
    expect(modelChange.parentId).toBeNull();
    expect(thinkingChange.parentId).toBe(modelChange.id);
    expect(getLastLeafId(entries)).toBe(thinkingChange.id);
    // No messages yet, but the active model/thinking level are resolvable.
    const context = sm.buildSessionContext();
    expect(context.messages).toHaveLength(0);
    expect(context.model).toEqual({ provider: "openrouter", modelId: "x/y" });
    expect(context.thinkingLevel).toBe("off");
  });

  it("appendMessage chains each new message to the current leaf and advances it", async () => {
    const { sm } = manager();
    await sm.createSession(DEFAULTS);
    await sm.appendMessage(userMessage("first"));
    const secondId = await sm.appendMessage(userMessage("second"));
    await sm.appendMessage(userMessage("third"));

    // Walking from the returned leaf reconstructs all three in order.
    expect(sm.buildSessionContext().messages.map((m) => text(m))).toEqual(["first", "second", "third"]);
    // The returned id is the new leaf.
    expect(sm.getActiveSessionInfo().messageCount).toBe(3);
    void secondId;
  });

  it("loadSession refuses a file missing the session header", async () => {
    const { sm, adapter } = manager();
    adapter.files.set("sessions/broken.jsonl", `${JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "t",
      message: userMessage("no header"),
    })}\n`);
    await expect(sm.loadSession("sessions/broken.jsonl")).rejects.toThrow(/session header/i);
  });
});

describe("append-only resilience", () => {
  it("parseSessionEntries skips a corrupt line without losing the rest of the session", () => {
    // Contract: a partially-flushed/garbled line is dropped, not fatal.
    const good = (id: string, parentId: string | null): string =>
      JSON.stringify({ type: "message", id, parentId, timestamp: "t", message: userMessage(id) });
    const content = [
      `${JSON.stringify({ type: "session", version: 1, id: "sid", timestamp: "t", cwd: "v" })}`,
      good("m1", null),
      "{ this line is not valid json ",
      good("m2", "m1"),
      "",
    ].join("\n");
    const entries = parseSessionEntries(content);
    expect(entries.map((e) => (e.type === "message" ? (e as { id: string }).id : e.type))).toEqual([
      "session",
      "m1",
      "m2",
    ]);
  });
});

describe("exact-once persistence (WeakSet de-dupe)", () => {
  /** Scripts one assistant message per agent turn. */
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

  function makeService(streamFn: StreamFn): { service: AgentService; adapter: MemoryAdapter } {
    const settings: AgenticChatSettings = { ...DEFAULT_SETTINGS, openrouterApiKey: "test-key", mode: "plan" };
    const adapter = new MemoryAdapter();
    const sessionManager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
    const service = new AgentService({
      app: { vault: { on: () => ({}), offref: () => {} }, workspace: {} } as unknown as App,
      getSettings: () => settings,
      sessionManager,
      confirmToolCall: async () => true,
      streamFn,
    });
    return { service, adapter };
  }

  it("persists a tool-call turn exactly once, including the tool-result message", async () => {
    // Plan mode blocks the mutating `write` call, so pi synthesizes an isError
    // tool-result and feeds it back. That tool-result must be persisted (exactly
    // once), alongside the user, assistant(toolCall), and follow-up assistant.
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "note.md", content: "hi" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "Read-only, so I held off." }], stopReason: "stop" },
    ]);
    const { service, adapter } = makeService(streamFn);
    await service.sendPrompt("Create note.md");

    const sessionFile = [...adapter.files.keys()].find((p) => p.endsWith(".jsonl")) as string;
    const entries = parseSessionEntries(adapter.files.get(sessionFile) as string);
    const messages = entries.filter((e): e is Extract<SessionEntry, { type: "message" }> => e.type === "message");

    // Contract: four messages, in order, with the tool-result present.
    expect(messages.map((m) => m.message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);

    // WeakSet de-dupe: message_end fires per message AND agent_end re-emits every
    // message, yet each must be written exactly once. No two entries may collide.
    const serialized = messages.map((m) => JSON.stringify(m));
    expect(new Set(serialized).size).toBe(serialized.length);
    // And specifically: exactly one tool-result line.
    expect(messages.filter((m) => m.message.role === "toolResult")).toHaveLength(1);

    // Reconstructing from the written file reproduces the same transcript, in order.
    const rebuilt = buildSessionContext(entries);
    expect(rebuilt.messages.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });
});

function text(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
    .map((b) => b.text)
    .join("");
}
