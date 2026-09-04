import type { ShouldStopAfterTurnContext } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";

/** Default streak of consecutive identical tool batches that triggers the guard. */
export const LOOP_GUARD_DEFAULT_MAX_IDENTICAL_BATCHES = 4;

/** Static prefix kept for tests/grep; fired notices append batch detail. */
export const LOOP_GUARD_NOTICE_TEXT = "Loop guard: the same tool batch repeated with identical results.";

/**
 * Build the fired notice. Names the repeated tools so the user sees the cause
 * at a glance; denial loops (all results are errors) get an approval hint.
 * Plain text, appended at the end of the transcript — never injected mid-context.
 */
export function buildLoopGuardNotice(toolNames: readonly string[], count: number, allError: boolean): string {
  const batch = toolNames.length <= 3 ? toolNames.map((name) => `“${name}”`).join(" + ") : `${toolNames.length} tools`;
  const cause = allError
    ? " All results were errors (often a denied approval) — allow the tool or change approach."
    : " Stopped to avoid burning tokens — tell me how to continue.";
  return `Loop guard: stopped after ${count} identical ${batch} calls with identical results.${cause}`;
}

/** Deterministic FNV-1a 32-bit hex hash (matches undo/observability style). */
export function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `h${hash.toString(16)}`;
}

/**
 * JSON stringify with recursively sorted object keys, so argument objects that
 * differ only in key order hash identically.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    // JSON.stringify(undefined) / functions / symbols returns undefined, not a
    // string — normalize so hashing never receives a non-string input.
    const json = JSON.stringify(value);
    return json === undefined ? "undefined" : json;
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

function hashToolContent(blocks: readonly { type: string; text?: string }[]): string {
  const texts = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string);
  return fnv1a(texts.length === 0 ? "\u0000" : texts.join("\u0000"));
}

/**
 * Ordered tool-batch key for one assistant turn: name + hashed args per call,
 * in call order. Returns null for tool-free turns (a model answer).
 */
export function toolBatchKey(message: { content: readonly unknown[] }): string | null {
  const calls = message.content.filter(
    (block): block is { type: "toolCall"; name: string; arguments: unknown } =>
      typeof block === "object" && block !== null && (block as { type?: string }).type === "toolCall",
  );
  if (calls.length === 0) return null;
  return calls.map((call) => `${call.name}:${fnv1a(stableStringify(call.arguments))}`).join("\n");
}

/** Tool names of one assistant turn, in call order. Empty for tool-free turns. */
export function toolBatchNames(message: { content: readonly unknown[] }): string[] {
  return message.content
    .filter(
      (block): block is { type: "toolCall"; name: string } =>
        typeof block === "object" && block !== null && (block as { type?: string }).type === "toolCall",
    )
    .map((call) => (typeof call.name === "string" ? call.name : "unknown"));
}

/** Ordered result key for the tool results of one turn (text + error flag). */
export function toolResultKey(results: readonly ToolResultMessage[]): string {
  return results
    .map(
      (result) =>
        `${result.isError ? "err" : "ok"}:${hashToolContent(result.content as readonly { type: string; text?: string }[])}`,
    )
    .join("\n");
}

export interface LoopGuardOptions {
  /** Identical consecutive batches before the guard fires. Defaults to 4. */
  maxIdenticalBatches?: number;
}

/**
 * Deterministic degeneration guard for the main agent: counts consecutive
 * assistant turns that issued the exact same ordered tool batch (same tool
 * names + arguments) AND received the exact same result text. A match means
 * the model is repeating itself without consuming new information (sampling
 * degeneration, e.g. deepseek-v4-flash), not polling — any arg or result
 * change breaks the streak.
 *
 * Wired into the parent agent's `shouldStopAfterTurn` hook so a fire ends the
 * run gracefully before another LLM call. User-scoped: reset() runs on every
 * fresh prompt, so only uninterrupted streaks inside one run count.
 */
export class AgentLoopGuard {
  private lastBatchKey: string | null = null;
  private lastResultKey: string | null = null;
  private lastToolNames: string[] = [];
  private lastAllError = false;
  private identicalRuns = 0;
  private firedText: string | null = null;

  constructor(private readonly options: LoopGuardOptions = {}) {}

  get maxIdenticalBatches(): number {
    return this.options.maxIdenticalBatches ?? LOOP_GUARD_DEFAULT_MAX_IDENTICAL_BATCHES;
  }

  /** Non-null once the guard has fired, until the next reset(). */
  get noticeText(): string | null {
    return this.firedText;
  }

  /** Forget the streak and any fired notice. Called on every fresh user prompt. */
  reset(): void {
    this.lastBatchKey = null;
    this.lastResultKey = null;
    this.lastToolNames = [];
    this.lastAllError = false;
    this.identicalRuns = 0;
    this.firedText = null;
  }

  shouldStopAfterTurn(context: ShouldStopAfterTurnContext): boolean {
    try {
      // Hook contract (pi-agent-core): must not throw — a throw interrupts the
      // agent loop without a normal event sequence. Any unexpected message
      // shape falls back to "keep going".
      const batchKey = toolBatchKey(context.message);
      if (batchKey === null) {
        // Tool-free turn — the model answered. A loop can't continue past it.
        this.reset();
        return false;
      }
      const resultKey = toolResultKey(context.toolResults);
      if (batchKey === this.lastBatchKey && resultKey === this.lastResultKey) {
        this.identicalRuns += 1;
      } else {
        this.lastBatchKey = batchKey;
        this.lastResultKey = resultKey;
        this.lastToolNames = toolBatchNames(context.message);
        this.lastAllError =
          context.toolResults.length > 0 && context.toolResults.every((result) => result.isError === true);
        this.identicalRuns = 1;
      }
      if (this.identicalRuns < this.maxIdenticalBatches) return false;
      this.firedText = buildLoopGuardNotice(this.lastToolNames, this.maxIdenticalBatches, this.lastAllError);
      return true;
    } catch {
      return false;
    }
  }
}
