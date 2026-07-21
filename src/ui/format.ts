import type { Usage } from "@earendil-works/pi-ai";

/** Truncate to `max` characters, appending an ellipsis when cut. */
export function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * Short, glanceable model label for the composer pill. OpenRouter ids are long
 * (`anthropic/claude-opus-4`, `deepseek/deepseek-chat-v3-0324:free`); drop the
 * provider prefix and keep the rest (including any `:free`/`:nitro` variant). The
 * full id is still shown in the pill's tooltip.
 */
export function shortModelLabel(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;
  const lastSegment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return lastSegment || trimmed;
}

/** Human labels for the vault tools, used to caption tool-step cards. */
export const TOOL_LABELS: Record<string, string> = {
  read: "Reading file",
  write: "Writing file",
  edit: "Editing file",
  ls: "Listing folder",
  search: "Searching",
  find: "Finding files",
  grep: "Searching",
  get_active_note: "Reading active note",
  rename: "Renaming",
  delete: "Deleting",
  external_inspect: "Inspecting external root",
  subagent: "Dispatching subagents",
};

/** Caption a tool call: a friendly label plus the most relevant path/pattern arg. */
export function describeCall(name: string, rawArgs: string): string {
  let detail = "";
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    const candidate = args.path ?? args.query ?? args.pattern ?? args.newPath;
    if (typeof candidate === "string") detail = candidate;
  } catch {
    // Arguments may be malformed; the label alone is still useful.
  }
  const label = TOOL_LABELS[name] ?? `Running ${name}`;
  return detail ? `${label}: ${detail}` : label;
}

/**
 * Render tool args as readable `key: value` lines (not raw JSON), each value
 * collapsed to a single line and truncated. Returns "" for empty/`{}` args so
 * the caller can omit the Tool-call section entirely. Long values (e.g. an
 * edit's oldText/newText) are capped so the section stays a few lines.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function formatArgsReadable(rawArgs: string, maxValueChars = 160): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return "";
  }
  if (!isPlainObject(parsed)) return "";
  const entries = Object.entries(parsed).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => {
      const raw = typeof value === "string" ? value : safeJson(value);
      const collapsed = raw.replace(/\s+/g, " ").trim();
      const shown = collapsed.length > maxValueChars ? `${collapsed.slice(0, maxValueChars)}…` : collapsed;
      return `${key}: ${shown}`;
    })
    .join("\n");
}

/**
 * Per-tool readable body for the "Tool call" section. Specialises a few tools so
 * the body stays short and useful instead of dumping every arg:
 *  - edit → path + edit count (never the raw oldText/newText, which truncates badly)
 *  - read / get_active_note → path + optional line range
 * Other tools fall back to {@link formatArgsReadable} (all key: value lines).
 */
export function formatCallBody(name: string, rawArgs: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return "";
  }
  if (!isPlainObject(parsed)) return "";
  if (name === "edit") {
    const parts: string[] = [];
    if (typeof parsed.path === "string" && parsed.path) parts.push(`path: ${parsed.path}`);
    const count = Array.isArray(parsed.edits) ? parsed.edits.length : 0;
    if (count > 0) parts.push(`${count} edit${count === 1 ? "" : "s"}`);
    return parts.join("\n");
  }
  if (name === "read" || name === "get_active_note") {
    const parts: string[] = [];
    if (typeof parsed.path === "string" && parsed.path) parts.push(`path: ${parsed.path}`);
    const offset = typeof parsed.offset === "number" ? parsed.offset : undefined;
    const limit = typeof parsed.limit === "number" ? parsed.limit : undefined;
    if (offset !== undefined || limit !== undefined) {
      const end = offset !== undefined && limit !== undefined ? offset + limit : "?";
      parts.push(`lines: ${offset ?? 0}–${end}`);
    }
    return parts.join("\n");
  }
  return formatArgsReadable(rawArgs);
}

/** Tools whose success result is just file contents already on disk / in context — hide it. */
export const HIDE_RESULT_TOOLS = new Set(["read", "get_active_note", "write", "subagent"]);

/** Tools whose primary arg is a vault path — render it as a clickable link in the step title. */
export const PATH_TOOLS = new Set(["read", "write", "edit", "delete", "rename", "get_active_note", "ls"]);

/** Extract the vault path (path, else newPath) from tool args, or "" if none/invalid. */
export function callPath(rawArgs: string): string {
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    if (!isPlainObject(parsed)) return "";
    if (typeof parsed.path === "string") return parsed.path;
    if (typeof parsed.newPath === "string") return parsed.newPath;
  } catch {
    // malformed args — no path
  }
  return "";
}

/** Stringify tool args, falling back to `{}` on circular/unserialisable values. */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

export function formatCost(total: number): string {
  // Cost is always a non-negative finite number; collapse anything else to zero
  // so a stray NaN/negative never renders as "$NaN" or "$-0.0050".
  if (!Number.isFinite(total) || total <= 0) return "$0.00";
  return total < 0.01 ? `$${total.toFixed(4)}` : `$${total.toFixed(2)}`;
}

/**
 * Prompt-cache hit ratio as a rounded percentage, or null when nothing was
 * cacheable. cacheRead = tokens served from cache (hits); the base is the full
 * prompt-token bill (input + cacheRead + cacheWrite), matching OpenRouter's
 * prompt_tokens decomposition. Returns null (not 0%) so we render nothing before
 * a cached turn exists rather than advertising an empty cache.
 */
export function cacheHitPercent(usage: Usage): number | null {
  const base = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  if (base <= 0) return null;
  return Math.round(((usage.cacheRead ?? 0) / base) * 100);
}

export interface DetailedUsageOptions {
  includesCompactedUsage?: boolean;
  includesSubagentUsage?: boolean;
}

export function formatDetailedUsage(usage: Usage, options: DetailedUsageOptions = {}): Array<[string, string]> {
  const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const cacheHit = cacheHitPercent(usage);
  const cost = usage.cost?.total;
  return [
    ["Scope", formatUsageScope(options)],
    ["Total tokens", formatTokenCount(usage.totalTokens)],
    ["Prompt tokens", formatTokenCount(promptTokens)],
    ["Fresh input", formatTokenCount(usage.input ?? 0)],
    ["Cache read", formatTokenCount(usage.cacheRead ?? 0)],
    ["Cache write", formatTokenCount(usage.cacheWrite ?? 0)],
    ["Output tokens", formatTokenCount(usage.output ?? 0)],
    [
      "Prompt cache hit",
      cacheHit === null ? "not available yet" : `${cacheHit}% of prompt tokens in this session`,
    ],
    ["Cost", typeof cost === "number" ? formatCost(cost) : "not reported by provider"],
  ];
}

export function formatUsage(usage: Usage): string {
  const total = usage.cost?.total ?? 0;
  const cost = total > 0 ? ` · ${formatCost(total)}` : "";
  const hit = cacheHitPercent(usage);
  const cache = hit === null ? "" : ` · ${hit}% cache`;
  return `${formatTokenInteger(usage.totalTokens)} tokens${cache}${cost}`;
}

/**
 * Full integer token count with thousands separators (e.g. `3,327,418`). Used for
 * the cumulative footer so the raw number stops reads as anxiety-inducing noise.
 */
export function formatTokenInteger(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  return Math.round(safe).toLocaleString("en-US");
}

/**
 * Format a single assistant turn's usage directly. Each message carries its own
 * per-response usage from the provider; there is no cumulative baseline to
 * subtract.
 */
export function formatUsageDelta(current: Usage, _previous?: Usage): string {
  return formatUsage(current);
}

/**
 * Human-readable elapsed time for a tool step: sub-second in ms, then seconds
 * with one decimal, then minutes+seconds. Negative/non-finite collapses to 0ms.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatUsageScope(options: DetailedUsageOptions): string {
  const included: string[] = [];
  if (options.includesCompactedUsage) included.push("compacted carried usage");
  if (options.includesSubagentUsage) included.push("subagent usage");
  if (included.length === 0) return "Active session";
  return `Active session, including ${included.join(" and ")}`;
}

function formatTokenCount(value: number): string {
  const safe = Number.isFinite(value) && value > 0 ? value : 0;
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(2)}M`;
  if (safe >= 1_000) {
    const thousands = safe / 1_000;
    return Number.isInteger(thousands) ? `${thousands}k` : `${trimTrailingZero(thousands.toFixed(1))}k`;
  }
  return String(Math.round(safe));
}

function trimTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}
