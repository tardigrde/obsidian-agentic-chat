import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  getLastLeafId,
  parseSessionEntries,
  type MessageSessionEntry,
  type SessionEntry,
} from "../src/session/jsonl";
import { emptyUsage } from "../src/agent/usage";
import { sumSessionUsage } from "../src/agent/session-usage";
import { ObsidianSessionManager, type SessionDefaults } from "../src/session/session-manager";
import { replayTextTurn, replayToolCallTurn } from "../src/agent/replay-stream";
import { MemoryAdapter } from "./helpers/memory-adapter";
import { runAgentReplay } from "./helpers/agent-replay";

const DEFAULTS: SessionDefaults = { provider: "openrouter", modelId: "x/y", thinkingLevel: "off" };

describe("session/event-log invariants", () => {
  it("preserves order, custom name, model state, and appendability across rewrite and reload", async () => {
    const { manager, adapter } = makeManager();
    const info = await manager.createSession(DEFAULTS);

    await manager.appendMessage(userMessage("first"));
    await manager.appendMessage(assistantMessage("first reply", 3));
    await manager.appendMessage(userMessage("second"));
    await manager.renameSession(info.path, "Important chat");
    await manager.ensureConfiguration({ provider: "openrouter", modelId: "changed/model", thinkingLevel: "high" });

    await manager.rewriteMessages([userMessage("first"), assistantMessage("first reply", 3)]);
    await manager.appendMessage(userMessage("fresh after rewrite"));

    const entries = assertSessionFile(adapter.files.get(info.path) ?? "", [
      "first",
      "first reply",
      "fresh after rewrite",
    ]);
    expect(manager.getActiveSessionInfo()).toMatchObject({
      path: info.path,
      name: "Important chat",
      messageCount: 3,
      firstMessage: "first",
    });
    expect(buildSessionContext(entries).model).toEqual({ provider: "openrouter", modelId: "changed/model" });
    expect(buildSessionContext(entries).thinkingLevel).toBe("high");

    const reloaded = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
    await reloaded.loadSession(info.path);
    expect(reloaded.getActiveSessionInfo()).toMatchObject({ name: "Important chat", messageCount: 3 });
    expect(reloaded.buildSessionContext().messages.map(messageText)).toEqual([
      "first",
      "first reply",
      "fresh after rewrite",
    ]);
  });

  it("recovers from a corrupt trailing JSONL line without losing the valid transcript", async () => {
    const { manager, adapter } = makeManager();
    const info = await manager.createSession(DEFAULTS);
    await manager.appendMessage(userMessage("before corrupt line"));
    await manager.appendMessage(assistantMessage("still valid", 2));
    await adapter.append(info.path, "{ not valid json");

    const reloaded = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
    await reloaded.loadSession(info.path);

    expect(reloaded.buildSessionContext().messages.map(messageText)).toEqual(["before corrupt line", "still valid"]);
    expect(reloaded.getActiveSessionInfo().messageCount).toBe(2);
    assertSessionFile(adapter.files.get(info.path) ?? "", ["before corrupt line", "still valid"]);
  });

  it("deletes the active session without damaging another session, then continues from the remaining session", async () => {
    const { manager, adapter } = makeManager();
    const first = await manager.createSession(DEFAULTS);
    await manager.appendMessage(userMessage("keep me"));
    const second = await manager.createSession(DEFAULTS);
    await manager.appendMessage(userMessage("delete me"));

    await manager.deleteSession(second.path);

    expect(manager.hasActiveSession()).toBe(false);
    expect(adapter.files.has(second.path)).toBe(false);
    expect(adapter.files.has(first.path)).toBe(true);

    const continued = await manager.continueRecentSession(DEFAULTS);
    expect(continued.path).toBe(first.path);
    expect(manager.buildSessionContext().messages.map(messageText)).toEqual(["keep me"]);
    assertSessionFile(adapter.files.get(first.path) ?? "", ["keep me"]);
  });

  it("persists replayed tool-result turns exactly once and preserves assistant usage on reload", async () => {
    const replay = await runAgentReplay({
      prompt: "Create note.md",
      settings: { mode: "plan" },
      turns: [
        replayToolCallTurn("call-1", "write", { path: "note.md", content: "hi" }, { usage: { totalTokens: 5 } }),
        replayTextTurn("I could not write in plan mode.", { usage: { input: 2, output: 4, totalTokens: 6 } }),
      ],
    });
    const sessionPath = [...replay.adapter.files.keys()].find((path) => path.endsWith(".jsonl"));
    if (!sessionPath) throw new Error("session file missing");

    const entries = assertSessionFile(replay.adapter.files.get(sessionPath) ?? "", [
      "Create note.md",
      "",
      /Plan mode is read-only/,
      "I could not write in plan mode.",
    ]);
    const messages = entries.filter((entry): entry is MessageSessionEntry => entry.type === "message");
    expect(messages.map((entry) => entry.message.role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
    expect(messages.filter((entry) => entry.message.role === "toolResult")).toHaveLength(1);

    const serializedMessages = messages.map((entry) => JSON.stringify(entry.message));
    expect(new Set(serializedMessages).size).toBe(serializedMessages.length);

    const reloaded = new ObsidianSessionManager(replay.adapter.asDataAdapter(), "sessions", "vault:test");
    await reloaded.loadSession(sessionPath);
    expect(reloaded.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(sumSessionUsage(reloaded.buildSessionContext().messages, emptyUsage()).totalTokens).toBe(11);
  });
});

function makeManager(): { manager: ObsidianSessionManager; adapter: MemoryAdapter } {
  const adapter = new MemoryAdapter();
  return {
    manager: new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test"),
    adapter,
  };
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistantMessage(text: string, totalTokens: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openrouter",
    model: "x/y",
    usage: {
      input: totalTokens,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
}

function assertSessionFile(content: string, expectedTexts: Array<string | RegExp>): SessionEntry[] {
  const entries = parseSessionEntries(content);
  expect(entries[0]?.type).toBe("session");

  const nonHeader = entries.filter((entry) => entry.type !== "session");
  const ids = nonHeader.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);

  const seen = new Set<string>();
  for (const entry of nonHeader) {
    if (entry.parentId !== null) expect(seen.has(entry.parentId), `missing parent ${entry.parentId}`).toBe(true);
    seen.add(entry.id);
  }

  expect(getLastLeafId(entries)).toBe(nonHeader.at(-1)?.id ?? null);
  const rebuilt = buildSessionContext(entries);
  expect(rebuilt.messages).toHaveLength(expectedTexts.length);
  for (const [index, expected] of expectedTexts.entries()) {
    const actual = messageText(rebuilt.messages[index]);
    if (typeof expected === "string") expect(actual).toBe(expected);
    else expect(actual).toMatch(expected);
  }
  return entries;
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => {
      return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
    })
    .map((block) => block.text)
    .join("");
}
