/**
 * Pure rules for the chat tab header: what a tab is called, which status dot
 * it shows, and which tabs fit in the strip. The DOM lives in tab-strip.ts.
 */

/** The status a tab can show. `null` means no dot. */
export type TabStatus = "needs-you" | "error" | "running" | "unread";

/** Most urgent first: an approval beats an error, which beats work, which beats news. */
const URGENCY: readonly TabStatus[] = ["needs-you", "error", "running", "unread"];

/** What a tab knows about itself when the strip renders. */
export interface TabStatusInput {
  needsApproval: boolean;
  streaming: boolean;
  error: boolean;
  unread: boolean;
}

/** One tab's dot: the most urgent thing true for it, or null. */
export function tabStatus(input: TabStatusInput): TabStatus | null {
  if (input.needsApproval) return "needs-you";
  if (input.error && !input.streaming) return "error";
  if (input.streaming) return "running";
  if (input.unread) return "unread";
  return null;
}

/** The most urgent status among several tabs (the overflow button's dot). */
export function mostUrgentStatus(statuses: ReadonlyArray<TabStatus | null>): TabStatus | null {
  for (const status of URGENCY) if (statuses.includes(status)) return status;
  return null;
}

/** Words for the tab's `aria-label` and tooltip. */
export const TAB_STATUS_TEXT: Record<TabStatus, string> = {
  "needs-you": "needs approval",
  error: "error",
  running: "working",
  unread: "new reply",
};

/** The tab's visible label: the user's label, else its 1-based number. */
export function tabDisplayLabel(index: number, tabLabel: string | undefined): string {
  return tabLabel?.trim() || String(index + 1);
}

/** `Tab 2, Project plan, needs approval` (the label part is left out when it is only the number). */
export function tabAriaLabel(index: number, tabLabel: string | undefined, status: TabStatus | null): string {
  const parts = [`Tab ${index + 1}`];
  const label = tabLabel?.trim();
  if (label) parts.push(label);
  if (status) parts.push(TAB_STATUS_TEXT[status]);
  return parts.join(", ");
}

/** Tooltip: `Tab 2 · <session name>` so the auto name stays one hover away. */
export function tabTooltip(index: number, sessionName: string | undefined): string {
  return `Tab ${index + 1} · ${sessionName?.trim() || "New chat"}`;
}

/**
 * Which tabs fit in `available` pixels, in order, always including the active
 * one. `reserve` is the width the overflow button needs when any tab is hidden.
 * Without measurements (all widths 0) every tab fits.
 */
export function fitTabs(widths: readonly number[], available: number, activeIndex: number, reserve: number, gap = 0): Set<number> {
  const all = new Set(widths.map((_, index) => index));
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= available) return all;
  const budget = available - reserve;
  const visible = new Set<number>();
  let used = activeIndex >= 0 && activeIndex < widths.length ? widths[activeIndex] : 0;
  if (activeIndex >= 0 && activeIndex < widths.length) visible.add(activeIndex);
  for (let index = 0; index < widths.length; index += 1) {
    if (index === activeIndex) continue;
    const next = used + gap + widths[index];
    // Keep the strip in order: the first tab that does not fit ends it.
    if (next > budget) break;
    visible.add(index);
    used = next;
  }
  return visible;
}
