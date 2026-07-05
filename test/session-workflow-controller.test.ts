import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/session/session-manager";
import { SessionWorkflowController } from "../src/ui/session-workflow-controller";
import type { SessionListCallbacks } from "../src/ui/session-list-modal";
import type { ActionRow, WorkflowRenderer } from "../src/ui/workflow-renderer";

type RenderCall =
  | { type: "clear" }
  | { type: "info"; title: string; entries: Array<[string, string]> }
  | { type: "error"; message: string }
  | { type: "actions"; title: string; subtitle: string; items: ActionRow[] };

interface OpenedList {
  sessions: SessionInfo[];
  activePath: string | null;
  callbacks: SessionListCallbacks;
}

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "session-a",
    path: "sessions/a.jsonl",
    createdAt: "2026-06-28T10:00:00.000Z",
    updatedAt: "2026-06-28T10:05:00.000Z",
    messageCount: 1,
    firstMessage: "Hello",
    ...overrides,
  };
}

function renderer(calls: RenderCall[]): WorkflowRenderer {
  return {
    clear: () => calls.push({ type: "clear" }),
    info: (title, entries) => calls.push({ type: "info", title, entries }),
    error: (message) => calls.push({ type: "error", message }),
    actionList: (title, subtitle, items) => calls.push({ type: "actions", title, subtitle, items }),
  };
}

function makeController(options: {
  sessions?: SessionInfo[];
  activePath?: string | null;
  clearCount?: number;
} = {}): {
  controller: SessionWorkflowController;
  calls: RenderCall[];
  opened: OpenedList[];
  loaded: string[];
  deleted: string[];
  renamed: Array<{ path: string; name: string }>;
  afterClear: string[];
  clearCalls: string[];
} {
  const calls: RenderCall[] = [];
  const opened: OpenedList[] = [];
  const loaded: string[] = [];
  const deleted: string[] = [];
  const renamed: Array<{ path: string; name: string }> = [];
  const afterClear: string[] = [];
  const clearCalls: string[] = [];
  return {
    calls,
    opened,
    loaded,
    deleted,
    renamed,
    afterClear,
    clearCalls,
    controller: new SessionWorkflowController({
      listSessions: async () => options.sessions ?? [],
      activeSessionPath: () => options.activePath ?? null,
      clearSessions: async () => {
        clearCalls.push("clear");
        return options.clearCount ?? 0;
      },
      loadSession: (path) => loaded.push(path),
      deleteSession: async (path) => {
        deleted.push(path);
      },
      renameSession: async (path, name) => {
        renamed.push({ path, name });
      },
      openList: (sessions, activePath, callbacks) => opened.push({ sessions, activePath, callbacks }),
      afterClear: () => afterClear.push("after-clear"),
      renderer: renderer(calls),
    }),
  };
}

describe("SessionWorkflowController", () => {
  it("opens only non-empty sessions and wires modal callbacks", async () => {
    const active = session({ id: "active", path: "sessions/active.jsonl", messageCount: 3 });
    const empty = session({ id: "empty", path: "sessions/empty.jsonl", messageCount: 0 });
    const ctx = makeController({ sessions: [empty, active], activePath: active.path });

    await ctx.controller.run("");

    expect(ctx.opened).toHaveLength(1);
    expect(ctx.opened[0]?.sessions).toEqual([active]);
    expect(ctx.opened[0]?.activePath).toBe(active.path);

    ctx.opened[0]?.callbacks.load(active);
    await ctx.opened[0]?.callbacks.delete(active);
    await ctx.opened[0]?.callbacks.rename(active, "Renamed");

    expect(ctx.loaded).toEqual([active.path]);
    expect(ctx.deleted).toEqual([active.path]);
    expect(ctx.renamed).toEqual([{ path: active.path, name: "Renamed" }]);
  });

  it("rejects unknown session subcommands without clearing", async () => {
    const ctx = makeController({ clearCount: 2 });

    await ctx.controller.run("prune");

    expect(ctx.calls).toContainEqual({ type: "error", message: 'Usage: /sessions [clear --confirm]' });
    expect(ctx.clearCalls).toEqual([]);
    expect(ctx.afterClear).toEqual([]);
  });

  it("requires confirmation before clearing conversations", async () => {
    const ctx = makeController({ clearCount: 2 });

    await ctx.controller.run("clear");
    expect(ctx.calls.some((call) => call.type === "error" && call.message.includes("--confirm"))).toBe(true);
    expect(ctx.clearCalls).toEqual([]);

    await ctx.controller.run("clear --confirm");
    expect(ctx.clearCalls).toEqual(["clear"]);
    expect(ctx.afterClear).toEqual(["after-clear"]);
    expect(ctx.calls).toContainEqual({
      type: "info",
      title: "Conversations",
      entries: [["Deleted", "2 conversations."]],
    });
  });
});
