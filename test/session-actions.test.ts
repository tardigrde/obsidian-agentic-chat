import { describe, expect, it } from "vitest";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import {
  AgentSessionActions,
  type AgentSessionActionsRuntime,
  type AgentSessionActivationRuntime,
} from "../src/agent/session-actions";
import type { ActivateSessionOptions } from "../src/agent/session-activation";
import type { ActiveSessionSnapshot } from "../src/agent/active-session-runtime";
import type { SessionInfo } from "../src/session/session-manager";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function sessionInfo(path: string, messageCount = 0): SessionInfo {
  return {
    id: path,
    path,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount,
    firstMessage: "",
  };
}

class FakeSessionRuntime implements AgentSessionActionsRuntime {
  activePath: string | null = null;
  created = 0;
  deleted: string[] = [];
  renamed: Array<{ path: string; name: string }> = [];
  refreshed = 0;
  rewrites: AgentMessage[][] = [];

  private readonly messagesByPath = new Map<string, AgentMessage[]>();

  seed(path: string, messages: AgentMessage[]): void {
    this.messagesByPath.set(path, messages);
  }

  async continueRecent(): Promise<ActiveSessionSnapshot> {
    if (this.activePath) return this.snapshot(this.activePath);
    return this.create();
  }

  async create(): Promise<ActiveSessionSnapshot> {
    this.created += 1;
    const path = `sessions/new-${this.created}.jsonl`;
    this.activePath = path;
    this.seed(path, []);
    return this.snapshot(path);
  }

  async load(path: string): Promise<ActiveSessionSnapshot> {
    this.activePath = path;
    return this.snapshot(path);
  }

  async list(): Promise<SessionInfo[]> {
    return [...this.messagesByPath.keys()].map((path) => sessionInfo(path, this.messagesByPath.get(path)?.length ?? 0));
  }

  async delete(path: string): Promise<void> {
    this.deleted.push(path);
    this.messagesByPath.delete(path);
    if (this.activePath === path) this.activePath = null;
  }

  async rename(path: string, name: string): Promise<void> {
    this.renamed.push({ path, name });
  }

  async rewriteMessages(messages: AgentMessage[]): Promise<ActiveSessionSnapshot> {
    const path = this.activePath ?? "sessions/current.jsonl";
    this.activePath = path;
    this.rewrites.push(messages);
    this.seed(path, messages);
    return this.snapshot(path);
  }

  refreshInfoIfActive(): SessionInfo | undefined {
    this.refreshed += 1;
    return this.activePath ? sessionInfo(this.activePath, this.messagesByPath.get(this.activePath)?.length ?? 0) : undefined;
  }

  private snapshot(path: string): ActiveSessionSnapshot {
    const messages = this.messagesByPath.get(path) ?? [];
    return {
      info: sessionInfo(path, messages.length),
      messages,
    };
  }
}

function agentWith(messages: AgentMessage[], isStreaming = false): Agent {
  return { state: { messages, isStreaming } } as Agent;
}

class FakeActivationRuntime implements AgentSessionActivationRuntime {
  currentAgent: Agent | null;

  constructor(
    private readonly events: string[],
    agent: Agent | null = null,
  ) {
    this.currentAgent = agent;
  }

  detachAgent(): void {
    this.events.push("detach");
    this.currentAgent = null;
  }

  async activate(messages: AgentMessage[], options: ActivateSessionOptions = {}): Promise<void> {
    this.events.push(`activate:${messages.length}:${options.reloadResources === false ? "no-reload" : "reload"}`);
    this.currentAgent = agentWith(messages);
  }
}

function makeActions(options: { sessions?: FakeSessionRuntime; agent?: Agent | null } = {}): {
  actions: AgentSessionActions;
  sessions: FakeSessionRuntime;
  events: string[];
} {
  const sessions = options.sessions ?? new FakeSessionRuntime();
  const events: string[] = [];
  const activation = new FakeActivationRuntime(events, options.agent ?? null);
  const actions = new AgentSessionActions({
    sessions,
    activation,
    notifyChange: () => events.push("notify"),
  });
  return { actions, sessions, events };
}

describe("AgentSessionActions", () => {
  it("continues the recent session by activating its persisted messages", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/recent.jsonl", [userMessage("recent")]);
    await sessions.load("sessions/recent.jsonl");
    const { actions, events } = makeActions({ sessions });

    await actions.continueRecentSession();

    expect(events).toEqual(["activate:1:reload", "notify"]);
  });

  it("starts a fresh session by detaching before activation", async () => {
    const { actions, sessions, events } = makeActions();

    await actions.newSession();

    expect(sessions.created).toBe(1);
    expect(events).toEqual(["detach", "activate:0:reload", "notify"]);
  });

  it("loads a session by detaching before activation", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/old.jsonl", [userMessage("persisted")]);
    const { actions, events } = makeActions({ sessions });

    await actions.loadSession("sessions/old.jsonl");

    expect(sessions.activePath).toBe("sessions/old.jsonl");
    expect(events).toEqual(["detach", "activate:1:reload", "notify"]);
  });

  it("deleting the active session creates and activates a replacement session", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/active.jsonl", [userMessage("active")]);
    await sessions.load("sessions/active.jsonl");
    const { actions, events } = makeActions({ sessions });

    await actions.deleteSession("sessions/active.jsonl");

    expect(sessions.deleted).toEqual(["sessions/active.jsonl"]);
    expect(sessions.created).toBe(1);
    expect(events).toEqual(["detach", "activate:0:reload", "notify"]);
  });

  it("deleting an inactive session only notifies listeners", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/active.jsonl", [userMessage("active")]);
    sessions.seed("sessions/old.jsonl", [userMessage("old")]);
    await sessions.load("sessions/active.jsonl");
    const { actions, events } = makeActions({ sessions });

    await actions.deleteSession("sessions/old.jsonl");

    expect(sessions.deleted).toEqual(["sessions/old.jsonl"]);
    expect(sessions.created).toBe(0);
    expect(events).toEqual(["notify"]);
  });

  it("renaming refreshes active info and notifies listeners", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/active.jsonl", [userMessage("active")]);
    await sessions.load("sessions/active.jsonl");
    const { actions, events } = makeActions({ sessions });

    await actions.renameSession("sessions/active.jsonl", "Renamed");

    expect(sessions.renamed).toEqual([{ path: "sessions/active.jsonl", name: "Renamed" }]);
    expect(sessions.refreshed).toBe(1);
    expect(events).toEqual(["notify"]);
  });

  it("rewinds persisted messages and replaces the live agent", async () => {
    const messages = [userMessage("one"), userMessage("two"), userMessage("three")];
    const sessions = new FakeSessionRuntime();
    await sessions.create();
    const { actions, events } = makeActions({ sessions, agent: agentWith(messages) });

    await actions.truncateMessages(2);

    expect(sessions.rewrites).toEqual([[messages[0], messages[1]]]);
    expect(events).toEqual(["activate:2:no-reload", "notify"]);
  });

  it("does not rewind while the live agent is streaming", async () => {
    const sessions = new FakeSessionRuntime();
    await sessions.create();
    const { actions, events } = makeActions({ sessions, agent: agentWith([userMessage("one")], true) });

    await actions.truncateMessages(0);

    expect(sessions.rewrites).toEqual([]);
    expect(events).toEqual([]);
  });
});
