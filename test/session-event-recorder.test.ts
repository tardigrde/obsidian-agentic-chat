import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AgentSessionEventRecorder } from "../src/agent/session-event-recorder";
import { ObsidianSessionManager } from "../src/session/session-manager";
import { parseSessionEntries, type SessionEntry } from "../src/session/jsonl";
import { MemoryAdapter } from "./helpers/memory-adapter";

const DEFAULTS = { provider: "openrouter", modelId: "x/y", thinkingLevel: "off" as const };

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 2,
  } as AgentMessage;
}

async function setup(): Promise<{
  adapter: MemoryAdapter;
  manager: ObsidianSessionManager;
  recorder: AgentSessionEventRecorder;
  path: string;
}> {
  const adapter = new MemoryAdapter();
  const manager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
  const info = await manager.createSession(DEFAULTS);
  return { adapter, manager, recorder: new AgentSessionEventRecorder(manager), path: info.path };
}

function messageEntries(adapter: MemoryAdapter, path: string): Extract<SessionEntry, { type: "message" }>[] {
  return parseSessionEntries(adapter.files.get(path) ?? "").filter(
    (entry): entry is Extract<SessionEntry, { type: "message" }> => entry.type === "message",
  );
}

describe("AgentSessionEventRecorder", () => {
  it("persists message_end and agent_end messages exactly once", async () => {
    const { adapter, recorder, path } = await setup();
    const user = userMessage("summarize the report");
    const assistant = assistantMessage("ok");

    await recorder.recordMessageEnd(user);
    await recorder.recordMessageEnd(assistant);
    await recorder.recordAgentEnd([user, assistant]);

    const messages = messageEntries(adapter, path);
    expect(messages.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
    expect(messages.filter((entry) => JSON.stringify(entry.message).includes("summarize the report"))).toHaveLength(1);
  });

  it("marks loaded or rewritten messages as already persisted", async () => {
    const { adapter, manager, recorder, path } = await setup();
    const loaded = userMessage("loaded prompt");
    const fresh = assistantMessage("fresh reply");
    await manager.appendMessage(loaded);
    recorder.markPersistedMessages([loaded]);

    await recorder.recordAgentEnd([loaded, fresh]);

    const messages = messageEntries(adapter, path);
    expect(messages.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
    expect(messages.filter((entry) => JSON.stringify(entry.message).includes("loaded prompt"))).toHaveLength(1);
    expect(messages.filter((entry) => JSON.stringify(entry.message).includes("fresh reply"))).toHaveLength(1);
  });

  it("auto-names unnamed sessions after the first persisted prompt", async () => {
    const { manager, recorder } = await setup();
    await recorder.recordAgentEnd([userMessage("  summarize   the quarterly report next week  ")]);

    expect(manager.getActiveSessionInfo().name).toBe("Summarize the quarterly report next week");
  });

  it("does not overwrite an existing custom session name", async () => {
    const { manager, recorder, path } = await setup();
    await manager.renameSession(path, "Important chat");
    await recorder.recordAgentEnd([userMessage("new prompt")]);

    expect(manager.getActiveSessionInfo().name).toBe("Important chat");
  });
});
