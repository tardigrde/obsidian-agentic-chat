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
 * Given an ascending list of thresholds and the set already notified, return the
 * highest threshold the value has reached but not yet been notified for (or null).
 * Notifying once per threshold per session avoids repeat toasts as usage drifts.
 */
export function highestUnnotifiedThreshold(
  value: number,
  thresholds: readonly number[],
  notified: ReadonlySet<number>,
): number | null {
  let result: number | null = null;
  for (const threshold of thresholds) {
    if (value >= threshold && !notified.has(threshold)) result = threshold;
  }
  return result;
}
