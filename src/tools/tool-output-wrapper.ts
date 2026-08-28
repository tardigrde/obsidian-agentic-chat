/**
 * Untrusted tool-output wrapper for H7.
 *
 * Web / MCP outputs are third-party data that must not be confused with
 * instructions. The harness wraps them with an explicit marker and escapes any
 * occurrence of the closing (and opening) marker inside the payload so an
 * attacker cannot break out.
 *
 * This is NOT a security boundary — tool authorization stays in
 * `tool-call-controller.ts` — but a defense-in-depth hint for the model.
 * The system prompt tells the model to treat content inside the markers as
 * DATA, never as instructions.
 */

import { truncateToolOutput } from "../vault/truncate";

export const TOOL_OUTPUT_BEGIN_PREFIX = "[BEGIN_UNTRUSTED_TOOL_OUTPUT";
export const TOOL_OUTPUT_END_MARKER = "[END_UNTRUSTED_TOOL_OUTPUT]";

/** Escaped forms used when the payload itself contains a marker. */
export const TOOL_OUTPUT_BEGIN_ESCAPED = "[BEGIN_UNTRUSTED_TOOL_OUTPUT_ESCAPED";
export const TOOL_OUTPUT_END_ESCAPED = "[END_UNTRUSTED_TOOL_OUTPUT_ESCAPED]";

/** Placeholders for bijective escaping of already-escaped literals. */
const PH_BEGIN_ESC = "\u0000__BEGIN_ESCAPED__\u0000";
const PH_END_ESC = "\u0000__END_ESCAPED__\u0000";

/**
 * Escape any marker-like sequences in untrusted text so they cannot close
 * (or fake-open) the wrapper. Replaces full markers and the prefix that
 * carries the `tool="..."` attribute. Handles payloads that already contain
 * escaped forms bijectively via placeholders.
 */
export function escapeToolOutput(text: string): string {
  // Fast path — most payloads contain no markers
  if (!text.includes("[BEGIN") && !text.includes("[END")) return text;
  return text
    .replaceAll(TOOL_OUTPUT_BEGIN_ESCAPED, PH_BEGIN_ESC)
    .replaceAll(TOOL_OUTPUT_END_ESCAPED, PH_END_ESC)
    .replaceAll(TOOL_OUTPUT_END_MARKER, TOOL_OUTPUT_END_ESCAPED)
    .replaceAll(TOOL_OUTPUT_BEGIN_PREFIX, TOOL_OUTPUT_BEGIN_ESCAPED)
    .replaceAll(PH_BEGIN_ESC, `${TOOL_OUTPUT_BEGIN_ESCAPED}_ORIG_`)
    .replaceAll(PH_END_ESC, `${TOOL_OUTPUT_END_ESCAPED}_ORIG_`);
}

/**
 * Wrap untrusted tool text with explicit boundary markers.
 *
 * `toolName` is optional — vault's generic `textResult` wrapper calls without
 * it to avoid threading the name through every call site. Web/MCP callers
 * pass the concrete tool name (e.g. `fetch_url`, `mcp__server__tool`) so the
 * model can see the source.
 *
 * Escaping is applied before wrapping.
 */
export function wrapToolOutput(text: string, toolName?: string): string {
  const escaped = escapeToolOutput(text);
  const begin = toolName?.trim()
    ? `${TOOL_OUTPUT_BEGIN_PREFIX} tool="${sanitizeToolName(toolName)}"]`
    : `${TOOL_OUTPUT_BEGIN_PREFIX}]`;
  return `${begin}\n${escaped}\n${TOOL_OUTPUT_END_MARKER}`;
}

/**
 * Wrap with truncation budget reserved for the wrapper. Use for hot-path
 * tool outputs that must not exceed DEFAULT_MAX_CHARS after wrapping.
 */
export function wrapToolOutputTruncated(text: string, toolName?: string, maxChars = 50_000): string {
  const overhead = toolName ? 90 : 60; // BEGIN line + END line + newlines + tool attr + escaping bloat
  const budget = Math.max(500, maxChars - overhead);
  const truncated = text.length > budget ? truncateToolOutput(text, budget) : text;
  return wrapToolOutput(truncated, toolName);
}

function sanitizeToolName(name: string): string {
  // Strict allowlist: keep alphanum, _ , - ; replace everything else (including ] [ " \r \n control) with _
  return name.replace(/[^a-z0-9_-]/gi, "_").slice(0, 128) || "tool";
}

/**
 * Strip the wrapper if present — useful for tests that need to inspect the
 * inner JSON/text. If the text is not wrapped, returns it unchanged.
 * Inverse of wrapToolOutput for round-trip testing.
 */
export function unwrapToolOutput(text: string): string {
  if (!text.startsWith(TOOL_OUTPUT_BEGIN_PREFIX)) return text;
  const firstNewline = text.indexOf("\n");
  const lastMarker = text.lastIndexOf(`\n${TOOL_OUTPUT_END_MARKER}`);
  if (firstNewline === -1 || lastMarker === -1) return text;
  const inner = text.slice(firstNewline + 1, lastMarker);
  // Reverse in opposite order: ORIG first, then regular
  return inner
    .replaceAll(`${TOOL_OUTPUT_BEGIN_ESCAPED}_ORIG_`, TOOL_OUTPUT_BEGIN_ESCAPED)
    .replaceAll(`${TOOL_OUTPUT_END_ESCAPED}_ORIG_`, TOOL_OUTPUT_END_ESCAPED)
    .replaceAll(TOOL_OUTPUT_BEGIN_ESCAPED, TOOL_OUTPUT_BEGIN_PREFIX)
    .replaceAll(TOOL_OUTPUT_END_ESCAPED, TOOL_OUTPUT_END_MARKER);
}
