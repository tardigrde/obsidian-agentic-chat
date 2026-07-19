import { describe, expect, it } from "vitest";
import {
  applySessionRename,
  emptySessionMessage,
  filterSessions,
  removeSessionByPath,
  resolveSessionRename,
  restoreSessionAt,
  sessionRenameDraft,
  sessionRows,
  sessionTitle,
} from "../src/ui/session-list-state";
import type { SessionInfo } from "../src/session/session-manager";

function session(over: Partial<SessionInfo>): SessionInfo {
  return {
    id: "id",
    path: "sessions/x.jsonl",
    createdAt: "2026-06-15T00:00:00Z",
    updatedAt: "2026-06-15T00:00:00Z",
    messageCount: 2,
    firstMessage: "",
    ...over,
  };
}

describe("filterSessions", () => {
  const sessions = [
    session({ path: "a", name: "Vault cleanup plan", firstMessage: "help me tidy notes" }),
    session({ path: "b", firstMessage: "What is RAG?" }),
    session({ path: "c", name: "Recipes", firstMessage: "pasta ideas" }),
  ];

  it("returns everything for an empty query", () => {
    expect(filterSessions(sessions, "")).toHaveLength(3);
    expect(filterSessions(sessions, "   ")).toHaveLength(3);
  });

  it("matches the custom name case-insensitively", () => {
    expect(filterSessions(sessions, "RECIPES").map((s) => s.path)).toEqual(["c"]);
  });

  it("matches the first message when there is no name", () => {
    expect(filterSessions(sessions, "rag").map((s) => s.path)).toEqual(["b"]);
  });

  it("matches substrings across both name and first message", () => {
    expect(filterSessions(sessions, "pasta").map((s) => s.path)).toEqual(["c"]);
    expect(filterSessions(sessions, "tidy").map((s) => s.path)).toEqual(["a"]);
  });

  it("returns nothing when no session matches", () => {
    expect(filterSessions(sessions, "zzz")).toHaveLength(0);
  });
});

describe("sessionRows", () => {
  it("maps filtered sessions to render-ready rows and marks the active row", () => {
    const rows = sessionRows(
      [
        session({ path: "a", name: "Active chat", messageCount: 1, updatedAt: "2026-06-15T10:00:00Z" }),
        session({ path: "b", name: "Other chat", messageCount: 3, updatedAt: "invalid-date" }),
      ],
      "chat",
      "a",
    );

    expect(rows.map((row) => ({ path: row.session.path, title: row.title, active: row.active }))).toEqual([
      { path: "a", title: "Active chat", active: true },
      { path: "b", title: "Other chat", active: false },
    ]);
    expect(rows[0].meta).toContain("1 message");
    expect(rows[1].meta).toBe("3 messages · ");
  });

  it("returns the correct empty-state copy", () => {
    expect(emptySessionMessage(0)).toBe("No saved conversations yet.");
    expect(emptySessionMessage(2)).toBe("No conversations match your search.");
  });
});

describe("session row state helpers", () => {
  it("removes a session by path without mutating the original list", () => {
    const sessions = [session({ path: "a" }), session({ path: "b" })];
    const next = removeSessionByPath(sessions, "a");

    expect(next.map((item) => item.path)).toEqual(["b"]);
    expect(sessions.map((item) => item.path)).toEqual(["a", "b"]);
  });

  it("restores an optimistically removed session at its original index", () => {
    const a = session({ path: "a" });
    const b = session({ path: "b" });
    const c = session({ path: "c" });
    const remaining = removeSessionByPath([a, b, c], "b");

    const restored = restoreSessionAt(remaining, b, 1);

    expect(restored.map((item) => item.path)).toEqual(["a", "b", "c"]);
    // The input list is not mutated.
    expect(remaining.map((item) => item.path)).toEqual(["a", "c"]);
  });

  it("clamps an out-of-range restore index to the end of the list", () => {
    const a = session({ path: "a" });
    const b = session({ path: "b" });

    expect(restoreSessionAt([a], b, 5).map((item) => item.path)).toEqual(["a", "b"]);
    expect(restoreSessionAt([a], b, -1).map((item) => item.path)).toEqual(["a", "b"]);
  });

  it("does not duplicate a session that is already present", () => {
    const a = session({ path: "a" });
    const b = session({ path: "b" });

    expect(restoreSessionAt([a, b], b, 0).map((item) => item.path)).toEqual(["a", "b"]);
  });

  it("builds display titles from custom names, first prompts, whitespace, and long text", () => {
    expect(sessionTitle(session({ name: "  Named chat  ", firstMessage: "ignored" }))).toBe("Named chat");
    expect(sessionTitle(session({ firstMessage: "first\nprompt" }))).toBe("first prompt");
    expect(sessionTitle(session({ firstMessage: "   " }))).toBe("(empty conversation)");
    expect(sessionTitle(session({ firstMessage: "x".repeat(90) }))).toBe(`${"x".repeat(80)}…`);
  });

  it("prefills rename from the custom name or first prompt", () => {
    expect(sessionRenameDraft(session({ name: "  Custom  ", firstMessage: "first" }))).toBe("Custom");
    expect(sessionRenameDraft(session({ firstMessage: "first prompt" }))).toBe("first prompt");
  });

  it("resolves rename commits, clears, no-ops, and cancels", () => {
    const named = session({ name: "Current", firstMessage: "first" });
    const unnamed = session({ firstMessage: "first" });

    expect(resolveSessionRename(named, "Next", true)).toBe("Next");
    expect(resolveSessionRename(named, "   ", true)).toBe("");
    expect(resolveSessionRename(named, "Current", true)).toBeNull();
    expect(resolveSessionRename(unnamed, "   ", true)).toBeNull();
    expect(resolveSessionRename(named, "Next", false)).toBeNull();
  });

  it("applies persisted rename state immutably", () => {
    const original = session({ name: "Old", firstMessage: "first" });
    expect(applySessionRename(original, "New")).toEqual({ ...original, name: "New" });
    expect(applySessionRename(original, "")).toEqual({ ...original, name: undefined });
    expect(original.name).toBe("Old");
  });
});
