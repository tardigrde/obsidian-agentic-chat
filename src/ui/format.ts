import type { Usage } from "@earendil-works/pi-ai";

/** Truncate to `max` characters, appending an ellipsis when cut. */
export function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Human labels for the vault tools, used to caption tool-step cards. */
export const TOOL_LABELS: Record<string, string> = {
  read: "Reading file",
  write: "Writing file",
  edit: "Editing file",
  ls: "Listing folder",
  find: "Finding files",
  grep: "Searching",
  get_active_note: "Reading active note",
  rename: "Renaming",
  delete: "Deleting",
  subagent: "Dispatching subagents",
};

/** Caption a tool call: a friendly label plus the most relevant path/pattern arg. */
export function describeCall(name: string, rawArgs: string): string {
  let detail = "";
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    const candidate = args.path ?? args.pattern ?? args.newPath;
    if (typeof candidate === "string") detail = candidate;
  } catch {
    // Arguments may be malformed; the label alone is still useful.
  }
  const label = TOOL_LABELS[name] ?? `Running ${name}`;
  return detail ? `${label}: ${detail}` : label;
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

export function formatUsage(usage: Usage): string {
  const total = usage.cost?.total ?? 0;
  const cost = total > 0 ? ` · ${formatCost(total)}` : "";
  return `${usage.totalTokens} tokens${cost}`;
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
