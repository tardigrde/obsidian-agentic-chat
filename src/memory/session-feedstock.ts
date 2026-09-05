import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "../session/jsonl";

/** Per-tool-result char budget inside Tier-2 feedstock (unbounded dumps are the norm). */
export const FEEDSTOCK_TOOL_RESULT_CHARS = 1_000;
/** Per-session char budget (final slice enforces the join). */
export const FEEDSTOCK_SESSION_CHARS = 4_000;

/** Zero-token quality gate for distillation deltas (replaces the Tier-1 capture gate). */
export const MIN_DISTILL_USER_TURNS = 3;
export const MIN_DISTILL_CHARS = 500;

export interface DistillDeltaGate {
  eligible: boolean;
  reason: string;
}

/** True when an uncovered message delta is worth a distill run (trivial chatter skipped). */
export function meetsDistillThreshold(messages: readonly AgentMessage[]): DistillDeltaGate {
  let userTurns = 0;
  let chars = 0;
  for (const message of messages) {
    const text = feedstockMessageText(message);
    if (!text) continue;
    chars += text.length;
    if ((message as { role?: unknown }).role === "user") userTurns += 1;
  }
  if (userTurns < MIN_DISTILL_USER_TURNS) {
    return { eligible: false, reason: `only ${userTurns} user turns (min ${MIN_DISTILL_USER_TURNS})` };
  }
  if (chars < MIN_DISTILL_CHARS) {
    return { eligible: false, reason: `only ${chars} chars (min ${MIN_DISTILL_CHARS})` };
  }
  return { eligible: true, reason: "ok" };
}

export const FEEDSTOCK_BEGIN = "<untrusted-transcripts>";
export const FEEDSTOCK_END = "</untrusted-transcripts>";
const FEEDSTOCK_END_ESCAPED = "</untrusted-transcripts (escaped)>";

/**
 * Serialize a session's message entries into bounded Tier-2 feedstock.
 * Message entries only — checkpoints/audits/plan entries are never read.
 * Thinking stripped, tool-call args reduced to names, tool results capped.
 * Output is framed as untrusted DATA with closers escaped (producer-side framing;
 * the distiller system prompt restates the DATA rule).
 */
export function serializeSessionFeedstock(
  entries: readonly SessionEntry[],
  label: string,
): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const text = feedstockMessageText(entry.message);
    if (text) lines.push(text);
  }
  if (lines.length === 0) return "";
  const joined = lines.join("\n");
  const capped = joined.length > FEEDSTOCK_SESSION_CHARS
    ? `${joined.slice(0, FEEDSTOCK_SESSION_CHARS)}\n[…truncated]`
    : joined;
  return `${FEEDSTOCK_BEGIN} session="${label}"\n${escapeFeedstock(capped)}\n${FEEDSTOCK_END}`;
}

/** Strip thinking blocks (reasoning leakage + noise). Shared with compaction archives. */
export function stripThinkingBlocks(message: AgentMessage): AgentMessage {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string" || !Array.isArray(content)) return message;
  const kept = content.filter(
    (block) => typeof block !== "object" || block === null || (block as { type?: unknown }).type !== "thinking",
  );
  if (kept.length === content.length) return message;
  return { ...(message as unknown as Record<string, unknown>), content: kept } as AgentMessage;
}

function feedstockMessageText(message: AgentMessage): string {
  const stripped = stripThinkingBlocks(message);
  const content = (stripped as { content?: unknown }).content;
  if (typeof content === "string") {
    return capLine(content.trim(), false);
  }
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  const calls: string[] = [];
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
  const role = (stripped as { role?: unknown }).role;
  if (role === "toolResult") {
    // Tool output is the injection vector: keep it, but hard-cap it.
    const combined = texts.join("\n");
    return capLine(combined, true);
  }
  const combined = calls.length > 0 ? [...texts, `[tool calls: ${calls.join("; ")}]`].join("\n") : texts.join("\n");
  return capLine(combined, false);
}

function capLine(text: string, isToolResult: boolean): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  if (isToolResult && collapsed.length > FEEDSTOCK_TOOL_RESULT_CHARS) {
    return `${collapsed.slice(0, FEEDSTOCK_TOOL_RESULT_CHARS)}…`;
  }
  return collapsed;
}

function escapeFeedstock(text: string): string {
  return text.split(FEEDSTOCK_END).join(FEEDSTOCK_END_ESCAPED).split(FEEDSTOCK_BEGIN).join("<untrusted-transcripts (escaped)>");
}
