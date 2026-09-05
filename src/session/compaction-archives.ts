import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** One archived pre-compaction turn. Thinking blocks are never archived. */
export interface CompactionArchiveTurn {
  turnIndex: number;
  role: string;
  timestamp?: number;
  text: string;
  /** True when the text came from a toolResult (re-wrap as untrusted on recall). */
  toolDerived: boolean;
}

export interface CompactionArchive {
  name: string;
  createdAt: string;
  turns: CompactionArchiveTurn[];
}

/** Per-turn char cap so one giant tool result can't blow the archive budget. */
export const ARCHIVE_TURN_CHARS = 2_000;
/** Keep the last N archives per session; older ones are pruned on write. */
export const MAX_ARCHIVES_PER_SESSION = 2;
/** Never read an archive file larger than this (stale/corrupt guard). */
export const MAX_ARCHIVE_FILE_CHARS = 200_000;

export function compactedArchiveDir(sessionDir: string): string {
  return `${sessionDir}/compacted`;
}

/** Strip thinking blocks (reasoning leakage + noise for weak models). */
export function stripThinkingBlocks(message: AgentMessage): AgentMessage {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" || !Array.isArray(content)) return message;
  const kept = content.filter(
    (block) => typeof block !== "object" || block === null || (block as { type?: unknown }).type !== "thinking",
  );
  if (kept.length === content.length) return message;
  return { ...(message as unknown as Record<string, unknown>), content: kept } as AgentMessage;
}

/** Extract recall-safe text from one message. Empty string when nothing recallable. */
export function archiveTurnText(message: AgentMessage): { text: string; toolDerived: boolean } {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return { text: capTurnText(content.trim()), toolDerived: false };
  }
  if (!Array.isArray(content)) return { text: "", toolDerived: false };
  const texts: string[] = [];
  const calls: string[] = [];
  let toolDerived = false;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const type = (block as { type?: unknown }).type;
    if (type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) texts.push(text.trim());
    } else if (type === "toolCall") {
      const name = (block as { name?: unknown }).name;
      if (typeof name === "string" && name) calls.push(name);
    }
  }
  if ((message as { role?: unknown }).role === "toolResult") toolDerived = texts.length > 0 || calls.length > 0;
  const combined = calls.length > 0 ? [...texts, `[tool calls: ${calls.join("; ")}]`].join("\n") : texts.join("\n");
  return { text: capTurnText(combined), toolDerived };
}

function capTurnText(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > ARCHIVE_TURN_CHARS ? `${collapsed.slice(0, ARCHIVE_TURN_CHARS)}…` : collapsed;
}

/** Build archive turns from a compaction summarize slice (thinking stripped, empties dropped). */
export function buildArchiveTurns(messages: readonly AgentMessage[]): CompactionArchiveTurn[] {
  const turns: CompactionArchiveTurn[] = [];
  messages.forEach((message, index) => {
    const stripped = stripThinkingBlocks(message);
    const { text, toolDerived } = archiveTurnText(stripped);
    if (!text) return;
    const record = message as { role?: unknown; timestamp?: unknown };
    turns.push({
      turnIndex: index,
      role: typeof record.role === "string" ? record.role : "unknown",
      ...(typeof record.timestamp === "number" ? { timestamp: record.timestamp } : {}),
      text,
      toolDerived,
    });
  });
  return turns;
}

export function serializeArchiveTurns(turns: readonly CompactionArchiveTurn[]): string {
  return `${turns.map((turn) => JSON.stringify(turn)).join("\n")}\n`;
}

export function parseArchiveTurns(content: string): CompactionArchiveTurn[] {
  const turns: CompactionArchiveTurn[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<CompactionArchiveTurn>;
      if (typeof parsed.text !== "string" || !parsed.text) continue;
      turns.push({
        turnIndex: typeof parsed.turnIndex === "number" ? parsed.turnIndex : turns.length,
        role: typeof parsed.role === "string" ? parsed.role : "unknown",
        ...(typeof parsed.timestamp === "number" ? { timestamp: parsed.timestamp } : {}),
        text: parsed.text.slice(0, ARCHIVE_TURN_CHARS + 1),
        toolDerived: parsed.toolDerived === true,
      });
    } catch {
      continue;
    }
  }
  return turns;
}

/** Machine-readable index line embedded in the compaction summary message. */
export function formatRecallIndex(archiveName: string, turns: number): string {
  return `<!-- recall-index archive="${archiveName}" turns=${turns} -->`;
}
