import { Notice } from "obsidian";

/**
 * Thin notification layer over Obsidian's `Notice`. Toasts are reserved for
 * background signals (agent finished, context-window filling, cost crossing a
 * cap); foreground slash output renders in-pane instead. Errors always show.
 */
export type NotifyCategory = "agentFinished" | "contextWindow" | "cost" | "error" | "info";

/** Sink is injectable so tests can capture notifications without Obsidian. */
export type NoticeSink = (message: string, timeoutMs?: number) => void;

const defaultSink: NoticeSink = (message, timeoutMs) => {
  new Notice(message, timeoutMs);
};

export class Notifier {
  constructor(
    private readonly isEnabled: () => boolean,
    private readonly sink: NoticeSink = defaultSink,
  ) {}

  /** Emit a notification. Errors bypass the enabled toggle; others honor it. Returns whether it fired. */
  notify(category: NotifyCategory, message: string, timeoutMs?: number): boolean {
    if (category !== "error" && !this.isEnabled()) return false;
    this.sink(message, timeoutMs);
    return true;
  }
}

/**
 * Return the single threshold to notify for: the highest one `value` has reached,
 * or null if nothing new. Only the highest reached threshold is ever surfaced — if
 * it (or a higher one) was already notified, we stay quiet. This avoids a stale
 * lower-threshold toast firing after the value jumped past several thresholds at once.
 */
export function highestUnnotifiedThreshold(
  value: number,
  thresholds: readonly number[],
  notified: ReadonlySet<number>,
): number | null {
  let highestReached: number | null = null;
  for (const threshold of thresholds) {
    if (value >= threshold && (highestReached === null || threshold > highestReached)) {
      highestReached = threshold;
    }
  }
  if (highestReached === null) return null;
  for (const threshold of thresholds) {
    if (threshold >= highestReached && notified.has(threshold)) return null;
  }
  return highestReached;
}
