import { describe, expect, it } from "vitest";
import { filterSessions } from "../src/ui/session-list-modal";
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
