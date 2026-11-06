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
  continued = 0;
  recentPath: string | null = null;
  events: string[] = [];
  private revision = 0;

  get generation(): number {
    return this.revision;
  }

  private readonly messagesByPath = new Map<string, AgentMessage[]>();

  seed(path: string, messages: AgentMessage[]): void {
    this.messagesByPath.set(path, messages);
  }

  async continueRecent(): Promise<ActiveSessionSnapshot> {
    this.continued += 1;
    // Mirrors the real helper: most recently modified, not the active pointer.
    if (this.recentPath) {
      this.revision += 1;
      this.activePath = this.recentPath;
      return this.snapshot(this.recentPath);
    }
    return this.create();
  }

  async create(): Promise<ActiveSessionSnapshot> {
    this.created += 1;
    const path = `sessions/new-${this.created}.jsonl`;
    this.events.push("create");
    this.revision += 1;
    this.activePath = path;
    this.seed(path, []);
    return this.snapshot(path);
  }

  async load(path: string): Promise<ActiveSessionSnapshot> {
    this.events.push("load");
    if (!this.messagesByPath.has(path)) throw new Error(`Session ${path} does not exist.`);
    this.revision += 1;
    this.activePath = path;
    return this.snapshot(path);
  }

  async list(): Promise<SessionInfo[]> {
    return [...this.messagesByPath.keys()].map((path) => sessionInfo(path, this.messagesByPath.get(path)?.length ?? 0));
  }

  async delete(path: string): Promise<void> {
    this.events.push("delete");
    this.deleted.push(path);
    this.messagesByPath.delete(path);
    if (this.activePath === path) {
      this.revision += 1;
      this.activePath = null;
    }
  }

  async rename(path: string, name: string): Promise<void> {
    this.renamed.push({ path, name });
  }

  async rewriteMessages(messages: AgentMessage[]): Promise<ActiveSessionSnapshot> {
    const path = this.activePath ?? "sessions/current.jsonl";
    this.events.push("rewrite");
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
  failPrepare = false;
  prepareCalls = 0;

  constructor(
    private readonly events: string[],
    agent: Agent | null = null,
  ) {
    this.currentAgent = agent;
  }

  async prepareResources(): Promise<void> {
    this.prepareCalls += 1;
    this.events.push("prepare");
    if (this.failPrepare) throw new Error("resource reload failed");
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

function makeActions(options: {
  sessions?: FakeSessionRuntime;
  agent?: Agent | null;
  afterDelete?: () => void | Promise<void>;
} = {}): {
  actions: AgentSessionActions;
  sessions: FakeSessionRuntime;
  activation: FakeActivationRuntime;
  events: string[];
} {
  const sessions = options.sessions ?? new FakeSessionRuntime();
  const events: string[] = [];
  sessions.events = events;
  const activation = new FakeActivationRuntime(events, options.agent ?? null);
  const actions = new AgentSessionActions({
    sessions,
    activation,
    notifyChange: () => events.push("notify"),
    afterDelete: options.afterDelete,
  });
  return { actions, sessions, activation, events };
}

describe("AgentSessionActions", () => {
  it("continues the recent session by activating its persisted messages", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/recent.jsonl", [userMessage("recent")]);
    sessions.recentPath = "sessions/recent.jsonl";
    await sessions.load("sessions/recent.jsonl");
    const { actions, events } = makeActions({ sessions });

    await actions.continueRecentSession();

    expect(events).toEqual(["prepare", "detach", "activate:1:no-reload", "notify"]);
  });

  it("starts a fresh session by detaching before activation", async () => {
    const { actions, sessions, events } = makeActions();

    await actions.newSession();

    expect(sessions.created).toBe(1);
    expect(events).toEqual(["prepare", "detach", "create", "activate:0:no-reload", "notify"]);
  });

  it("loads a session by detaching before activation", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/old.jsonl", [userMessage("persisted")]);
    const { actions, events } = makeActions({ sessions });

    await actions.loadSession("sessions/old.jsonl");

    expect(sessions.activePath).toBe("sessions/old.jsonl");
    expect(events).toEqual(["prepare", "detach", "load", "activate:1:no-reload", "notify"]);
  });

  it("reloads resources before detaching and keeps the old agent when the reload fails", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/old.jsonl", [userMessage("persisted")]);
    await sessions.load("sessions/old.jsonl");
    const oldAgent = agentWith([userMessage("old")]);
    const { actions, activation, events } = makeActions({ sessions, agent: oldAgent });
    activation.failPrepare = true;

    await expect(actions.loadSession("sessions/old.jsonl")).rejects.toThrow("resource reload failed");

    expect(events).toEqual(["prepare"]);
    expect(activation.currentAgent).toBe(oldAgent);
    expect(actions.getSwapState()).toBe("live");
  });

  it("keeps sends open when a failed reload leaves the old agent alive", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/old.jsonl", [userMessage("persisted")]);
    await sessions.load("sessions/old.jsonl");
    const oldAgent = agentWith([userMessage("old")]);
    const { actions, activation } = makeActions({ sessions, agent: oldAgent });
    activation.failPrepare = true;

    await expect(actions.loadSession("sessions/old.jsonl")).rejects.toThrow("resource reload failed");
    expect(actions.getSwapState()).toBe("live");

    await expect(actions.waitForLive()).resolves.toBeUndefined();
    await actions.ensureSessionAgent();

    expect(activation.currentAgent).toBe(oldAgent);
    expect(sessions.continued).toBe(0);
    expect(actions.getSwapState()).toBe("live");
  });

  it("restores the previous session when the targeted load fails after detach", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/previous.jsonl", [userMessage("previous")]);
    sessions.seed("sessions/target.jsonl", [userMessage("target")]);
    sessions.seed("sessions/recent.jsonl", [userMessage("recent")]);
    sessions.recentPath = "sessions/recent.jsonl";
    await sessions.load("sessions/previous.jsonl");
    const { actions, activation } = makeActions({ sessions, agent: agentWith([userMessage("previous")]) });
    const originalLoad = sessions.load.bind(sessions);
    sessions.load = async (path: string) => {
      if (path === "sessions/target.jsonl") throw new Error("target load failed");
      return originalLoad(path);
    };

    await expect(actions.loadSession("sessions/target.jsonl")).rejects.toThrow(
      "Could not load sessions/target.jsonl; the previous session is still open.",
    );

    expect(sessions.activePath).toBe("sessions/previous.jsonl");
    expect(activation.currentAgent?.state.messages).toEqual([userMessage("previous")]);
    expect(sessions.continued).toBe(0);
    expect(actions.getSwapState()).toBe("live");
    sessions.load = originalLoad;
  });

  it("falls back to the most recent session when the previous reload also fails", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/old.jsonl", [userMessage("old")]);
    sessions.seed("sessions/recent.jsonl", [userMessage("recent")]);
    sessions.recentPath = "sessions/recent.jsonl";
    await sessions.load("sessions/old.jsonl");
    const { actions, activation } = makeActions({ sessions, agent: agentWith([userMessage("old")]) });
    const originalLoad = sessions.load.bind(sessions);
    sessions.load = async () => {
      throw new Error("load failed after detach");
    };

    await expect(actions.loadSession("sessions/old.jsonl")).rejects.toThrow("load failed after detach");
    expect(activation.currentAgent).toBeNull();
    expect(actions.getSwapState()).toBe("failed");

    await expect(actions.waitForLive()).resolves.toBeUndefined();
    await actions.ensureSessionAgent();

    expect(sessions.continued).toBe(1);
    expect(activation.currentAgent?.state.messages).toEqual([userMessage("recent")]);
    expect(actions.getSwapState()).toBe("live");
    sessions.load = originalLoad;
  });

  it("recovers a failed swap when the next session operation succeeds", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/old.jsonl", [userMessage("persisted")]);
    await sessions.load("sessions/old.jsonl");
    const { actions, activation, events } = makeActions({ sessions });
    activation.failPrepare = true;
    await expect(actions.loadSession("sessions/old.jsonl")).rejects.toThrow();
    expect(actions.getSwapState()).toBe("failed");

    activation.failPrepare = false;
    await actions.newSession();

    expect(actions.getSwapState()).toBe("live");
    expect(events).toContain("activate:0:no-reload");
  });

  it("serializes initialize behind a queued swap instead of loading twice", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/recent.jsonl", [userMessage("recent")]);
    await sessions.load("sessions/recent.jsonl");
    const { actions, sessions: runtime } = makeActions({ sessions });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalLoad = runtime.load.bind(runtime);
    let loadCalls = 0;
    runtime.load = async (path: string) => {
      loadCalls += 1;
      await gate;
      return originalLoad(path);
    };

    const swap = actions.loadSession("sessions/recent.jsonl");
    const initialize = actions.ensureSessionAgent();
    release();
    await Promise.all([swap, initialize]);

    expect(actions.getSwapState()).toBe("live");
    expect(runtime.continued).toBe(0);
    expect(loadCalls).toBe(1);
  });

  it("exposes loading and live states while a swap runs", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/old.jsonl", [userMessage("persisted")]);
    await sessions.load("sessions/old.jsonl");
    const { actions } = makeActions({ sessions });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalLoad = sessions.load.bind(sessions);
    sessions.load = async (path: string) => {
      await gate;
      return originalLoad(path);
    };

    const swap = actions.loadSession("sessions/old.jsonl");
    await Promise.resolve();
    expect(actions.getSwapState()).toBe("loading");
    release();
    await swap;
    expect(actions.getSwapState()).toBe("live");
  });

  it("deleting the active session creates and activates a replacement session", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/active.jsonl", [userMessage("active")]);
    await sessions.load("sessions/active.jsonl");
    const { actions, events } = makeActions({ sessions });

    await actions.deleteSession("sessions/active.jsonl");

    expect(sessions.deleted).toEqual(["sessions/active.jsonl"]);
    expect(sessions.created).toBe(1);
    expect(events).toEqual(["prepare", "detach", "delete", "create", "activate:0:no-reload", "notify"]);
  });

  it("restores the previous session when deleting the active session fails after detach", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/active.jsonl", [userMessage("active")]);
    await sessions.load("sessions/active.jsonl");
    const { actions, activation } = makeActions({ sessions, agent: agentWith([userMessage("active")]) });
    sessions.delete = async () => {
      throw new Error("delete failed");
    };

    await expect(actions.deleteSession("sessions/active.jsonl")).rejects.toThrow(
      "Could not delete sessions/active.jsonl; a session is still open.",
    );

    expect(sessions.activePath).toBe("sessions/active.jsonl");
    expect(activation.currentAgent?.state.messages).toEqual([userMessage("active")]);
  });

  it("recovers the next recent session when replacement creation fails after an active delete", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/active.jsonl", [userMessage("active")]);
    sessions.seed("sessions/recent.jsonl", [userMessage("recent")]);
    sessions.recentPath = "sessions/recent.jsonl";
    await sessions.load("sessions/active.jsonl");
    const { actions, activation } = makeActions({ sessions, agent: agentWith([userMessage("active")]) });
    sessions.create = async () => {
      throw new Error("create failed");
    };

    await expect(actions.deleteSession("sessions/active.jsonl")).rejects.toThrow(
      "Could not delete sessions/active.jsonl; a session is still open.",
    );

    expect(sessions.continued).toBe(1);
    expect(sessions.activePath).toBe("sessions/recent.jsonl");
    expect(activation.currentAgent?.state.messages).toEqual([userMessage("recent")]);
  });

  it("recovers a live session when clearing sessions fails after detach", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/active.jsonl", [userMessage("active")]);
    sessions.seed("sessions/old.jsonl", [userMessage("old")]);
    sessions.seed("sessions/recent.jsonl", [userMessage("recent")]);
    sessions.recentPath = "sessions/recent.jsonl";
    await sessions.load("sessions/active.jsonl");
    const { actions, activation } = makeActions({ sessions, agent: agentWith([userMessage("active")]) });
    const originalDelete = sessions.delete.bind(sessions);
    let deleteCalls = 0;
    sessions.delete = async (path: string) => {
      deleteCalls += 1;
      if (deleteCalls === 2) throw new Error("clear delete failed");
      return originalDelete(path);
    };

    await expect(actions.clearSessions()).rejects.toThrow(
      "Could not clear sessions; a session is still open.",
    );

    expect(activation.currentAgent).not.toBeNull();
    expect(sessions.activePath).toBe("sessions/recent.jsonl");
    expect(actions.getSwapState()).toBe("live");
  });

  it("does not block a queued-prompt flush after a failed non-active delete", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/active.jsonl", [userMessage("active")]);
    sessions.seed("sessions/old.jsonl", [userMessage("old")]);
    await sessions.load("sessions/active.jsonl");
    const { actions, activation } = makeActions({ sessions, agent: agentWith([userMessage("active")]) });
    sessions.delete = async () => {
      throw new Error("delete failed");
    };

    await expect(actions.deleteSession("sessions/old.jsonl")).rejects.toThrow("delete failed");

    // The live agent survived the failed swap, so the UI may flush its queue.
    expect(activation.currentAgent).not.toBeNull();
    expect(actions.getSwapState()).toBe("live");
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
    expect(events).toEqual(["delete", "notify"]);
  });

  it("runs post-delete cleanup after sessions are removed", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/active.jsonl", [userMessage("active")]);
    sessions.seed("sessions/old.jsonl", [userMessage("old")]);
    await sessions.load("sessions/active.jsonl");
    const cleanupEvents: string[] = [];
    const { actions } = makeActions({
      sessions,
      afterDelete: async () => {
        cleanupEvents.push(`cleanup:${sessions.deleted.join(",")}`);
      },
    });

    await actions.deleteSession("sessions/old.jsonl");
    await actions.clearSessions();

    expect(cleanupEvents).toEqual([
      "cleanup:sessions/old.jsonl",
      "cleanup:sessions/old.jsonl,sessions/active.jsonl",
    ]);
  });

  it("clears all listed sessions and activates one replacement session", async () => {
    const sessions = new FakeSessionRuntime();
    sessions.seed("sessions/active.jsonl", [userMessage("active")]);
    sessions.seed("sessions/old.jsonl", [userMessage("old")]);
    await sessions.load("sessions/active.jsonl");
    const { actions, events } = makeActions({ sessions });

    await expect(actions.clearSessions()).resolves.toBe(2);

    expect(sessions.deleted).toEqual(["sessions/active.jsonl", "sessions/old.jsonl"]);
    expect(sessions.created).toBe(1);
    expect(events).toEqual(["prepare", "detach", "delete", "delete", "create", "activate:0:no-reload", "notify"]);
  });

  it("notifies without creating a replacement when there are no sessions to clear", async () => {
    const { actions, sessions, events } = makeActions();

    await expect(actions.clearSessions()).resolves.toBe(0);

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
    expect(events).toEqual(["prepare", "rewrite", "detach", "activate:2:no-reload", "notify"]);
  });

  // pi 1.0.0 keeps the system prompt as a leading transcript message, but the
  // UI indexes the conversation only. Rewinding to index N must therefore drop
  // N conversation messages and never persist the system context.
  it("rewinds by conversation index without persisting pi's system message", async () => {
    const one = userMessage("one");
    const two = userMessage("two");
    const three = userMessage("three");
    const system = { role: "system", content: "prompt", timestamp: 0 } as unknown as AgentMessage;
    const sessions = new FakeSessionRuntime();
    await sessions.create();
    const { actions, events } = makeActions({ sessions, agent: agentWith([system, one, two, three]) });

    await actions.truncateMessages(2);

    expect(sessions.rewrites).toEqual([[one, two]]);
    expect(events).toEqual(["prepare", "rewrite", "detach", "activate:2:no-reload", "notify"]);
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
