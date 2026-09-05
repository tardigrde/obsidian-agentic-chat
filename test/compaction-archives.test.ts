import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  ARCHIVE_TURN_CHARS,
  archiveTurnText,
  buildArchiveTurns,
  formatRecallIndex,
  parseArchiveTurns,
  serializeArchiveTurns,
  stripThinkingBlocks,
} from "../src/session/compaction-archives";

function textMessage(role: string, text: string): AgentMessage {
  return { role, content: [{ type: "text", text }], timestamp: 1 } as unknown as AgentMessage;
}

describe("compaction archives", () => {
  it("strips thinking blocks but keeps sibling text", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "secret chain of thought" },
        { type: "text", text: "visible answer" },
      ],
      timestamp: 1,
    } as unknown as AgentMessage;
    const stripped = stripThinkingBlocks(message);
    const content = (stripped as { content: unknown[] }).content;
    expect(content).toHaveLength(1);
    expect(JSON.stringify(stripped)).not.toContain("secret chain of thought");
  });

  it("extracts user/assistant text and marks toolResult as tool-derived", () => {
    expect(archiveTurnText(textMessage("user", "deploy at dawn"))).toMatchObject({
      text: "deploy at dawn",
      toolDerived: false,
    });
    const toolResult = {
      role: "toolResult",
      content: [{ type: "text", text: "test output: 3 passed" }],
      timestamp: 2,
    } as unknown as AgentMessage;
    expect(archiveTurnText(toolResult)).toMatchObject({ text: "test output: 3 passed", toolDerived: true });
  });

  it("builds turns with indices, drops empties, and caps giant turns", () => {
    const turns = buildArchiveTurns([
      textMessage("user", "   "),
      textMessage("user", "the deploy requirement is friday"),
      textMessage("assistant", `x${"y".repeat(ARCHIVE_TURN_CHARS + 100)}`),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ turnIndex: 1, role: "user" });
    expect(turns[1]?.text.length).toBeLessThanOrEqual(ARCHIVE_TURN_CHARS + 1);
  });

  it("round-trips through serialize/parse and skips corrupt lines", () => {
    const turns = buildArchiveTurns([textMessage("user", "keep this requirement")]);
    const parsed = parseArchiveTurns(`${serializeArchiveTurns(turns)}not json\n\n`);
    expect(parsed).toEqual(turns);
  });

  it("formats a machine-readable recall index", () => {
    expect(formatRecallIndex("abc__2026-09-05.jsonl", 12)).toBe(
      '<!-- recall-index archive="abc__2026-09-05.jsonl" turns="12" -->',
    );
  });
});
