import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { deriveAutoName, ObsidianSessionManager } from "../src/session/session-manager";
import { parseSessionEntries } from "../src/session/jsonl";
import { runPlanTrackerCommand } from "../src/agent/plan-tracker";
import { MemoryAdapter } from "./helpers/memory-adapter";

const DEFAULTS = { provider: "openrouter", modelId: "x/y", thinkingLevel: "off" as const };

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function manager(): { sm: ObsidianSessionManager; adapter: MemoryAdapter } {
  const adapter = new MemoryAdapter();
  const sm = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
  return { sm, adapter };
}

function scopedManager(): {
  sm: ObsidianSessionManager;
  adapter: MemoryAdapter;
  scope: { projectId?: string; projectName?: string };
} {
  const adapter = new MemoryAdapter();
  const scope: { projectId?: string; projectName?: string } = {};
  const sm = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test", () => scope);
  return { sm, adapter, scope };
}

describe("ObsidianSessionManager project sessions", () => {
  it("tags new sessions with the active project and lists only that project group", async () => {
    const { sm, adapter, scope } = scopedManager();
    scope.projectId = "alpha";
    scope.projectName = "Alpha";
    const alpha = await sm.createSession(DEFAULTS);
    await sm.appendMessage(userMessage("alpha prompt"));

    scope.projectId = "beta";
    scope.projectName = "Beta";
    const beta = await sm.createSession(DEFAULTS);
    await sm.appendMessage(userMessage("beta prompt"));

    let sessions = await sm.listSessions();
    expect(sessions.map((session) => session.id)).toEqual([beta.id]);
    expect(sessions[0]).toMatchObject({ projectId: "beta", projectName: "Beta" });

    scope.projectId = "alpha";
    scope.projectName = "Alpha";
    sessions = await sm.listSessions();
    expect(sessions.map((session) => session.id)).toEqual([alpha.id]);

    const alphaEntries = parseSessionEntries(adapter.files.get(alpha.path) ?? "");
    expect(alphaEntries[0]).toMatchObject({
      type: "session",
      projectId: "alpha",
      projectName: "Alpha",
    });
  });

  it("keeps vault-wide sessions separate from project sessions", async () => {
    const { sm, scope } = scopedManager();
    const vaultWide = await sm.createSession(DEFAULTS);
    scope.projectId = "alpha";
    scope.projectName = "Alpha";
    await sm.createSession(DEFAULTS);

    scope.projectId = undefined;
    scope.projectName = undefined;

    expect((await sm.listSessions()).map((session) => session.id)).toEqual([vaultWide.id]);
  });
});

describe("ObsidianSessionManager.renameSession", () => {
  it("renames the active session in memory", async () => {
    const { sm } = manager();
    const info = await sm.createSession(DEFAULTS);
    await sm.appendMessage(userMessage("hello"));
    await sm.renameSession(info.path, "Renamed");
    expect(sm.getActiveSessionInfo().name).toBe("Renamed");
  });

  it("renames a non-active session by appending to its file", async () => {
    const { sm } = manager();
    const first = await sm.createSession(DEFAULTS);
    await sm.appendMessage(userMessage("hello"));
    await sm.createSession(DEFAULTS); // first is no longer active
    await sm.renameSession(first.path, "Old chat");
    const reloaded = await sm.loadSession(first.path);
    expect(reloaded.name).toBe("Old chat");
  });

  it("treats a blank name as cleared", async () => {
    const { sm } = manager();
    const info = await sm.createSession(DEFAULTS);
    await sm.renameSession(info.path, "   ");
    expect(sm.getActiveSessionInfo().name).toBeUndefined();
  });
});

describe("ObsidianSessionManager.rewriteMessages", () => {
  it("rewinds the transcript and persists the truncated chain", async () => {
    const { sm, adapter } = manager();
    const info = await sm.createSession(DEFAULTS);
    await sm.appendMessage(userMessage("first"));
    await sm.appendMessage(userMessage("second"));
    await sm.appendMessage(userMessage("third"));

    await sm.rewriteMessages([userMessage("first")]);

    const context = sm.buildSessionContext();
    expect(context.messages).toHaveLength(1);
    expect(context.model).toEqual({ provider: "openrouter", modelId: "x/y" });
    expect(sm.getActiveSessionInfo().messageCount).toBe(1);

    // The file on disk reflects the rewrite, not the old longer history.
    const entries = parseSessionEntries(adapter.files.get(info.path) ?? "");
    expect(entries.filter((e) => e.type === "message")).toHaveLength(1);
    expect(entries[0]?.type).toBe("session");
  });

  it("preserves a custom session name across a rewrite", async () => {
    const { sm } = manager();
    const info = await sm.createSession(DEFAULTS);
    await sm.appendMessage(userMessage("first"));
    await sm.appendMessage(userMessage("second"));
    await sm.renameSession(info.path, "Important chat");
    await sm.rewriteMessages([userMessage("first")]);
    expect(sm.getActiveSessionInfo().name).toBe("Important chat");
  });

  it("can rewind to an empty transcript", async () => {
    const { sm } = manager();
    await sm.createSession(DEFAULTS);
    await sm.appendMessage(userMessage("only"));
    await sm.rewriteMessages([]);
    expect(sm.buildSessionContext().messages).toHaveLength(0);
    // A subsequent append still chains correctly off the rewritten leaf.
    await sm.appendMessage(userMessage("fresh"));
    const texts = sm.buildSessionContext().messages.map(
      (m) => (m as unknown as { content: [{ text: string }] }).content[0].text,
    );
    expect(texts).toEqual(["fresh"]);
  });

  it("preserves the latest plan tracker state across a rewrite", async () => {
    const { sm, adapter } = manager();
    const info = await sm.createSession(DEFAULTS);
    await sm.appendMessage(userMessage("first"));
    const tracked = runPlanTrackerCommand(null, "add Milestone", "2026-06-26T12:00:00.000Z").state;
    await sm.appendPlanTracker(tracked);
    await sm.appendMessage(userMessage("second"));

    await sm.rewriteMessages([userMessage("first")]);

    expect(sm.getActivePlanTracker()).toMatchObject({ items: [{ id: "1", title: "Milestone" }] });
    const entries = parseSessionEntries(adapter.files.get(info.path) ?? "");
    expect(entries.at(-1)).toMatchObject({ type: "plan_tracker", state: { items: [{ id: "1", title: "Milestone" }] } });
  });
});

describe("ObsidianSessionManager plan tracker", () => {
  it("persists and reloads the active plan tracker", async () => {
    const { sm } = manager();
    const info = await sm.createSession(DEFAULTS);
    const tracked = runPlanTrackerCommand(null, "add Milestone", "2026-06-26T12:00:00.000Z").state;
    await sm.appendPlanTracker(tracked);

    await sm.createSession(DEFAULTS);
    await sm.loadSession(info.path);

    expect(sm.getActivePlanTracker()).toMatchObject({
      title: "Plan tracker",
      items: [{ id: "1", title: "Milestone", status: "pending", testStatus: "not_run" }],
    });
  });

  it("persists a cleared tracker as the latest state", async () => {
    const { sm } = manager();
    await sm.createSession(DEFAULTS);
    await sm.appendPlanTracker(runPlanTrackerCommand(null, "add Milestone", "2026-06-26T12:00:00.000Z").state);
    await sm.appendPlanTracker(null);

    expect(sm.getActivePlanTracker()).toBeNull();
  });
});

describe("deriveAutoName", () => {
  it("titles a short prompt", () => {
    expect(deriveAutoName("hi")).toBe("Hi");
  });

  it("collapses whitespace and trims to a handful of words", () => {
    const name = deriveAutoName("  summarize   the    quarterly report for the leadership team next week  ");
    expect(name).toBe("Summarize the quarterly report for the leadership team");
  });

  it("strips an attachment context preamble", () => {
    expect(deriveAutoName("<context>\nlots of note text\n</context>\n\nWrite a summary")).toBe("Write a summary");
  });

  it("strips a leading /skill invocation", () => {
    expect(deriveAutoName("/skill summarize the note")).toBe("Summarize the note");
  });

  it("drops trailing punctuation", () => {
    expect(deriveAutoName("what is this?")).toBe("What is this");
  });

  it("returns undefined for empty input", () => {
    expect(deriveAutoName("   ")).toBeUndefined();
  });
});
