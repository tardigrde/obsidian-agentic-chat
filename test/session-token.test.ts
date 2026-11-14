import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AgentService } from "../src/agent/agent-service";
import { isSummaryMessage } from "../src/agent/compaction";
import { parseSessionEntries } from "../src/session/jsonl";
import { ObsidianSessionManager } from "../src/session/session-manager";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings-schema";
import { MemoryAdapter } from "./helpers/memory-adapter";

/**
 * Race guards around the session token, pinned through the public service API
 * so they hold whatever owns the token. A token is opaque: these tests only
 * capture it and hand it back.
 */

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

interface Gate {
  started: Promise<void>;
  release: () => void;
  wait: () => Promise<void>;
}

function gate(): Gate {
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    started,
    release,
    wait: async () => {
      start();
      await open;
    },
  };
}

function makeService(summarize?: () => Promise<string>): { service: AgentService; adapter: MemoryAdapter } {
  const settings: AgenticChatSettings = { ...DEFAULT_SETTINGS, openrouterApiKey: "test-key" };
  const adapter = new MemoryAdapter();
  const service = new AgentService({
    app: { vault: { on: () => ({}), offref: () => {} }, workspace: {} } as unknown as App,
    getSettings: () => settings,
    sessionManager: new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test"),
    confirmToolCall: async () => ({ approved: true, remember: false }),
    streamFn: cannedStreamFn("ok"),
    summarize: summarize ?? (async () => "Summary of earlier turns."),
  });
  return { service, adapter };
}

function userTexts(messages: readonly AgentMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => JSON.stringify(message.content));
}

async function persistedMessages(adapter: MemoryAdapter, service: AgentService): Promise<AgentMessage[]> {
  const path = service.getSessionInfo()?.path as string;
  return parseSessionEntries(await adapter.read(path))
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

describe("session token guards", () => {
  it("delivers a send prepared before a manual compaction landed", async () => {
    const { service } = makeService();
    await service.sendPrompt("first request");
    await service.sendPrompt("second request");
    const token = service.getSessionToken();

    await expect(service.compactNow()).resolves.toMatchObject({ compacted: true });
    await service.sendPrompt("prepared before compaction", undefined, token);

    expect(service.getError()).toBeUndefined();
    expect(userTexts(service.getMessages()).some((text) => text.includes("prepared before compaction"))).toBe(true);
  });

  it("rejects a send prepared before a rewind", async () => {
    const { service } = makeService();
    await service.sendPrompt("first request");
    await service.sendPrompt("second request");
    const token = service.getSessionToken();

    await service.truncateMessages(2);
    await service.sendPrompt("prepared before rewind", undefined, token);

    expect(service.getError()).toMatch(/session changed while preparing this turn/i);
    expect(userTexts(service.getMessages())).toHaveLength(1);
  });

  it("accepts a send bound to the conversation a rewind produced", async () => {
    const { service } = makeService();
    await service.sendPrompt("first request");
    await service.sendPrompt("second request");

    await service.truncateMessages(2);
    await service.sendPrompt("resend", undefined, service.getSessionToken());

    expect(service.getError()).toBeUndefined();
    expect(userTexts(service.getMessages())).toHaveLength(2);
  });

  it("does not let a compaction that finishes after a session swap touch the new session", async () => {
    const summary = gate();
    const { service, adapter } = makeService(async () => {
      await summary.wait();
      return "Summary of the old session.";
    });
    await service.sendPrompt("first request");
    await service.sendPrompt("second request");
    const oldPath = service.getSessionInfo()?.path as string;

    const compaction = service.compactNow();
    await summary.started;
    await service.newSession();
    summary.release();

    await expect(compaction).resolves.toMatchObject({ compacted: false });
    expect(service.getSessionInfo()?.path).not.toBe(oldPath);
    expect(service.getMessages()).toEqual([]);
    expect(await persistedMessages(adapter, service)).toEqual([]);
    // The old session keeps its transcript: no summary replaced it.
    const oldMessages = parseSessionEntries(await adapter.read(oldPath))
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    expect(oldMessages).toHaveLength(4);
    expect(oldMessages.some((message) => isSummaryMessage(message))).toBe(false);
  });

  it("keeps the live transcript and the session file in step when a swap queues behind a compaction", async () => {
    const summary = gate();
    const { service, adapter } = makeService(async () => {
      await summary.wait();
      return "Summary that lands before the swap.";
    });
    await service.sendPrompt("first request");
    await service.sendPrompt("second request");

    const compaction = service.compactNow();
    await summary.started;
    summary.release();
    const swap = service.newSession();
    await Promise.all([compaction, swap]);

    // Whichever order the two landed in, the live agent holds exactly what the
    // active session file holds.
    expect(service.getMessages()).toEqual(await persistedMessages(adapter, service));
  });
});
