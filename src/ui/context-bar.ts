import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextReadout } from "../agent/readouts";
import { formatTokensCompact } from "./format";

/**
 * Pure logic behind the composer's context ring: the fill level, the percent,
 * and the breakdown tooltip. The levels mirror the notification thresholds
 * (75% / 90%) so the ring and the toasts agree.
 */
export type ContextLevel = "ok" | "warn" | "high";

/** Bucket a context-fill fraction (0–1) into a color level. */
export function contextLevel(fraction: number): ContextLevel {
  if (fraction >= 0.9) return "high";
  if (fraction >= 0.75) return "warn";
  return "ok";
}

/** Clamp a fraction to a 0–100 integer percentage. */
export function contextPercent(fraction: number): number {
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  return Math.min(100, Math.round(fraction * 100));
}

const LABEL_WIDTH = 17;
const VALUE_WIDTH = 7;

function share(tokens: number, window: number): string {
  if (window <= 0) return "";
  return `${Math.round((tokens / window) * 100)}%`;
}

function row(label: string, value: string, extra = ""): string {
  return `${label.padEnd(LABEL_WIDTH)}${value.padStart(VALUE_WIDTH)}${extra ? `  ${extra}` : ""}`.trimEnd();
}

/**
 * The context ring's tooltip: the total, then the system prompt, tools,
 * conversation, and the reserve. Deferred tools are not sent, so they show as a
 * count. The numbers are estimates; `lastPromptTokens` is the provider's count
 * for the last reply, when it reported one.
 *
 *   38% · 48.6k / 128k tokens (estimated)
 *   System prompt      4.1k  3%
 *     Instructions     1.2k
 *   ...
 */
export function formatContextBreakdown(readout: ContextReadout, lastPromptTokens?: number): string {
  const { load, contextWindow } = readout;
  const percent = contextPercent(readout.fraction);
  const k = formatTokensCompact;
  const lines = [`${percent}% · ${k(load.totalTokens)} / ${k(contextWindow)} tokens (estimated)`];
  const parts = load.breakdown;
  lines.push(row("System prompt", k(load.systemPromptTokens), share(load.systemPromptTokens, contextWindow)));
  if (parts) {
    if (parts.instructionsTokens > 0) lines.push(row("  Instructions", k(parts.instructionsTokens), "(AGENTS.md)"));
    if (parts.skillsTokens > 0) lines.push(row("  Skills loaded", k(parts.skillsTokens)));
  }
  lines.push(row("Tools", k(load.toolSchemaTokens), share(load.toolSchemaTokens, contextWindow)));
  if (parts) {
    lines.push(row("  Built-in", k(parts.builtinToolTokens)));
    if (parts.mcpToolTokens > 0) {
      lines.push(row("  MCP", k(parts.mcpToolTokens), `(${parts.mcpServers} server${parts.mcpServers === 1 ? "" : "s"})`));
    }
    if (parts.deferredNotLoaded > 0) {
      lines.push(`${"  MCP deferred".padEnd(LABEL_WIDTH)}${parts.deferredNotLoaded} tool${parts.deferredNotLoaded === 1 ? "" : "s"}, not loaded`);
    }
  }
  lines.push(row("Conversation", k(load.transcriptTokens), share(load.transcriptTokens, contextWindow)));
  if (parts && parts.toolResultTokens > 0) lines.push(row("  Tool results", k(parts.toolResultTokens)));
  lines.push(row("Kept for answer", k(load.reserveTokens)));
  if (lastPromptTokens !== undefined && lastPromptTokens > 0) {
    lines.push(`Last reply: ${k(lastPromptTokens)} tokens sent (provider count)`);
  }
  return lines.join("\n");
}

/**
 * The provider's prompt-token count for the last assistant reply (input plus
 * cache reads and writes), or undefined when no reply reported usage.
 */
export function lastPromptTokens(messages: readonly AgentMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const usage = (message as { usage?: { input?: number; cacheRead?: number; cacheWrite?: number } }).usage;
    if (!usage) return undefined;
    const total = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    return total > 0 ? total : undefined;
  }
  return undefined;
}
