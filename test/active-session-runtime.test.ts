import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AgentActiveSessionRuntime } from "../src/agent/active-session-runtime";
import { ObsidianSessionManager, type SessionDefaults } from "../src/session/session-manager";
import { runPlanTrackerCommand } from "../src/agent/plan-tracker";
import { MemoryAdapter } from "./helpers/memory-adapter";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function messageText(message: AgentMessage): string {
  return (message as unknown as { content: [{ text: string }] }).content[0].text;
}

function makeRuntime(getDefaults: () => SessionDefaults = () => DEFAULTS): {
  manager: ObsidianSessionManager;
  runtime: AgentActiveSessionRuntime;
} {
  const adapter = new MemoryAdapter();
  const manager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
  return {
    manager,
    runtime: new AgentActiveSessionRuntime(manager, getDefaults),
  };
}

const DEFAULTS: SessionDefaults = { provider: "openrouter", modelId: "x/y", thinkingLevel: "off" };

describe("AgentActiveSessionRuntime", () => {
  it("continues by creating a session when no recent session exists", async () => {
    const { runtime } = makeRuntime();

    const snapshot = await runtime.continueRecent();

    expect(snapshot.info.path).toMatch(/sessions\/.*\.jsonl/);
    expect(snapshot.messages).toEqual([]);
    expect(runtime.info).toBe(snapshot.info);
    expect(runtime.activePath).toBe(snapshot.info.path);
  });

  it("loads a session snapshot with reconstructed messages", async () => {
    const { manager, runtime } = makeRuntime();
    const first = await runtime.create();
    await manager.appendMessage(userMessage("first"));
    await runtime.create();

    const loaded = await runtime.load(first.info.path);

    expect(loaded.info.path).toBe(first.info.path);
    expect(loaded.messages.map(messageText)).toEqual(["first"]);
    expect(runtime.info?.path).toBe(first.info.path);
  });

  it("rewrites messages and refreshes the cached session info", async () => {
    const { manager, runtime } = makeRuntime();
    await runtime.create();
    await manager.appendMessage(userMessage("first"));
    await manager.appendMessage(userMessage("second"));

    const snapshot = await runtime.rewriteMessages([userMessage("first")]);

    expect(snapshot.messages.map(messageText)).toEqual(["first"]);
    expect(snapshot.info.messageCount).toBe(1);
    expect(runtime.info?.messageCount).toBe(1);
  });

  it("ensures configuration and refreshes active info", async () => {
    let defaults: SessionDefaults = DEFAULTS;
    const { manager, runtime } = makeRuntime(() => defaults);
    await runtime.create();
    defaults = { provider: "openrouter", modelId: "changed/model", thinkingLevel: "high" };

    const info = await runtime.ensureConfiguration();

    expect(info.path).toBe(runtime.info?.path);
    expect(manager.buildSessionContext().model).toEqual({ provider: "openrouter", modelId: "changed/model" });
    expect(manager.buildSessionContext().thinkingLevel).toBe("high");
  });

  it("saves and exposes the active plan tracker", async () => {
    const { runtime } = makeRuntime();
    await runtime.create();
    const tracked = runPlanTrackerCommand(null, "add Milestone", "2026-06-26T12:00:00.000Z").state;

    await runtime.savePlanTracker(tracked);

    expect(runtime.getPlanTracker()).toMatchObject({ items: [{ id: "1", title: "Milestone" }] });
    expect(runtime.info?.updatedAt).toBeTruthy();
  });

  it("clears cached info when deleting the active session", async () => {
    const { runtime } = makeRuntime();
    const snapshot = await runtime.create();

    await runtime.delete(snapshot.info.path);

    expect(runtime.info).toBeUndefined();
    expect(runtime.activePath).toBeNull();
  });
});
