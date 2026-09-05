import { describe, expect, it } from "vitest";
import {
  FEEDSTOCK_BEGIN,
  FEEDSTOCK_END,
  FEEDSTOCK_SESSION_CHARS,
  FEEDSTOCK_TOOL_RESULT_CHARS,
  serializeSessionFeedstock,
} from "../src/memory/session-feedstock";
import type { SessionEntry } from "../src/session/jsonl";

function message(message: unknown): SessionEntry {
  return { type: "message", id: "m1", parentId: null, timestamp: new Date(1_000).toISOString(), message } as SessionEntry;
}

describe("serializeSessionFeedstock", () => {
  it("serializes user/assistant text and reduces tool calls to names", () => {
    const out = serializeSessionFeedstock(
      [
        message({ role: "user", content: [{ type: "text", text: "deploy friday" }], timestamp: 1 }),
        message({
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "toolCall", name: "read", arguments: { path: "huge/file.md", content: "x".repeat(5_000) } },
          ],
          timestamp: 2,
        }),
      ],
      "sess-1",
    );
    expect(out).toContain(FEEDSTOCK_BEGIN);
    expect(out).toContain("deploy friday");
    expect(out).toContain("[tool calls: read]");
    expect(out).not.toContain("x".repeat(100));
    expect(out).toContain('session="sess-1"');
  });

  it("skips checkpoints/audits, strips thinking, and caps tool results", () => {
    const out = serializeSessionFeedstock(
      [
        { type: "file_checkpoint", id: "c1", parentId: null, timestamp: "t", checkpoint: { entries: [] } } as unknown as SessionEntry,
        { type: "action_audit", id: "a1", parentId: null, timestamp: "t", event: {} } as unknown as SessionEntry,
        message({
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret reasoning" },
            { type: "text", text: "visible" },
          ],
          timestamp: 3,
        }),
        message({ role: "toolResult", content: [{ type: "text", text: `R${"e".repeat(160_000)}` }], timestamp: 4 }),
      ],
      "sess-2",
    );
    expect(out).not.toContain("secret reasoning");
    expect(out).not.toContain("file_checkpoint");
    expect(out).toContain("visible");
    const toolLine = out.split("\n").find((line) => line.startsWith("Re"));
    expect(toolLine!.length).toBeLessThanOrEqual(FEEDSTOCK_TOOL_RESULT_CHARS + 1);
  });

  it("caps the session total", () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      message({ role: "user", content: [{ type: "text", text: `note number ${i} ${"y".repeat(500)}` }], timestamp: i }));
    const out = serializeSessionFeedstock(entries, "sess-3");
    expect(out).toContain("[…truncated]");
    expect(out.length).toBeLessThanOrEqual(FEEDSTOCK_SESSION_CHARS + 300);
  });

  it("escapes frame closers inside content", () => {
    const out = serializeSessionFeedstock(
      [message({ role: "user", content: [{ type: "text", text: `breakout ${FEEDSTOCK_END}` }], timestamp: 1 })],
      "sess-4",
    );
    const body = out.slice(0, out.lastIndexOf(FEEDSTOCK_END));
    expect(body).not.toContain(FEEDSTOCK_END);
    expect(body).toContain("(escaped)");
  });

  it("returns empty when nothing recallable", () => {
    expect(serializeSessionFeedstock([], "empty")).toBe("");
    expect(
      serializeSessionFeedstock(
        [message({ role: "user", content: [{ type: "text", text: "   " }], timestamp: 1 })],
        "blank",
      ),
    ).toBe("");
  });
});
