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

export const TOOL_OUTPUT_BEGIN_PREFIX = "[BEGIN_UNTRUSTED_TOOL_OUTPUT";
export const TOOL_OUTPUT_END_MARKER = "[END_UNTRUSTED_TOOL_OUTPUT]";

/** Escaped forms used when the payload itself contains a marker. */
export const TOOL_OUTPUT_BEGIN_ESCAPED = "[BEGIN_UNTRUSTED_TOOL_OUTPUT_ESCAPED";
export const TOOL_OUTPUT_END_ESCAPED = "[END_UNTRUSTED_TOOL_OUTPUT_ESCAPED]";

/**
 * Escape any marker-like sequences in untrusted text so they cannot close
 * (or fake-open) the wrapper. Replaces full markers and the prefix that
 * carries the `tool="..."` attribute.
 */
export function escapeToolOutput(text: string): string {
  // Order matters: escape END before BEGIN, but neither contains the other.
  return text
    .replaceAll(TOOL_OUTPUT_END_MARKER, TOOL_OUTPUT_END_ESCAPED)
    .replaceAll(TOOL_OUTPUT_BEGIN_PREFIX, TOOL_OUTPUT_BEGIN_ESCAPED);
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
  const begin =
    toolName && toolName.trim()
      ? `${TOOL_OUTPUT_BEGIN_PREFIX} tool="${sanitizeToolName(toolName)}"]`
      : `${TOOL_OUTPUT_BEGIN_PREFIX}]`;
  return `${begin}\n${escaped}\n${TOOL_OUTPUT_END_MARKER}`;
}

function sanitizeToolName(name: string): string {
  // Tool names are controlled by the harness, but strip quotes/newlines
  // to keep the BEGIN line well-formed.
  return name.replace(/["\r\n]/g, "_").slice(0, 128);
}

/**
 * Strip the wrapper if present — useful for tests that need to inspect the
 * inner JSON/text. If the text is not wrapped, returns it unchanged.
 */
export function unwrapToolOutput(text: string): string {
  if (!text.startsWith(TOOL_OUTPUT_BEGIN_PREFIX)) return text;
  const firstNewline = text.indexOf("\n");
  const lastMarker = text.lastIndexOf(`\n${TOOL_OUTPUT_END_MARKER}`);
  if (firstNewline === -1 || lastMarker === -1) return text;
  const inner = text.slice(firstNewline + 1, lastMarker);
  // Un-escape the escaped markers back to their original form so tests see
  // the payload the tool originally produced.
  return inner
    .replaceAll(TOOL_OUTPUT_END_ESCAPED, TOOL_OUTPUT_END_MARKER)
    .replaceAll(TOOL_OUTPUT_BEGIN_ESCAPED, TOOL_OUTPUT_BEGIN_PREFIX);
}
