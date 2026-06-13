import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildSessionContext,
  createSessionHeader,
  getLastLeafId,
  parseSessionEntries,
  serializeSessionEntries,
  type SessionEntry,
} from "../src/session/jsonl";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

describe("session jsonl", () => {
  it("round-trips entries through serialize/parse and skips blank lines", () => {
    const entries: SessionEntry[] = [
      createSessionHeader("sid", "vault", "2026-06-13T00:00:00.000Z"),
      { type: "message", id: "m1", parentId: null, timestamp: "t", message: userMessage("hi") },
    ];
    const serialized = `${serializeSessionEntries(entries)}\n\n`;
    expect(parseSessionEntries(serialized)).toEqual(entries);
  });

  it("walks the parent chain to reconstruct the active branch", () => {
    const entries: SessionEntry[] = [
      createSessionHeader("sid", "vault"),
      { type: "model_change", id: "c1", parentId: null, timestamp: "t", provider: "openrouter", modelId: "x/y" },
      { type: "thinking_level_change", id: "c2", parentId: "c1", timestamp: "t", thinkingLevel: "high" },
      { type: "message", id: "m1", parentId: "c2", timestamp: "t", message: userMessage("first") },
      { type: "message", id: "m2", parentId: "m1", timestamp: "t", message: userMessage("second") },
    ];
    const context = buildSessionContext(entries, "m2");
    expect(context.messages).toHaveLength(2);
    expect(context.model).toEqual({ provider: "openrouter", modelId: "x/y" });
    expect(context.thinkingLevel).toBe("high");
    expect(getLastLeafId(entries)).toBe("m2");
  });

  it("returns an empty branch for a null leaf", () => {
    const entries: SessionEntry[] = [createSessionHeader("sid", "vault")];
    expect(buildSessionContext(entries, null).messages).toHaveLength(0);
    expect(getLastLeafId(entries)).toBeNull();
  });
});
