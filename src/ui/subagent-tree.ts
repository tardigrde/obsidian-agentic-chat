import type { SubagentChildStatus } from "../tools/subagent-tool";
import {
  describeCall,
  formatCost,
  formatElapsed,
  formatTokenInteger,
  safeJson,
  truncateText,
} from "./format";

const SUBAGENT_STATUS_LABEL: Record<SubagentChildStatus["status"], string> = {
  queued: "queued",
  running: "running…",
  done: "done",
  error: "failed",
  aborted: "stopped",
};

/** Extract the child statuses from a subagent details payload, or [] when absent/malformed. */
export function subagentChildren(details: unknown): SubagentChildStatus[] {
  const shaped = details as { kind?: string; children?: unknown } | undefined;
  if (shaped?.kind !== "subagent" || !Array.isArray(shaped.children)) return [];
  return shaped.children.filter(
    (child): child is SubagentChildStatus =>
      !!child &&
      typeof child === "object" &&
      typeof (child as { agent?: unknown }).agent === "string" &&
      typeof (child as { status?: unknown }).status === "string",
  );
}

/**
 * Whether a subagent dispatch's settled child statuses force the step to render
 * as failed. A stopped (or timed-out) dispatch returns a NORMAL tool result —
 * so the parent won't re-dispatch — but the UI must still read it as stopped.
 * Accepts both shapes: the live tool result object and replay's wrapped
 * persisted details (`{ details }`).
 */
export function subagentResultForcesError(resultObject: unknown): boolean {
  const children = subagentChildren((resultObject as { details?: unknown } | undefined)?.details);
  return children.some((child) => child.status === "error" || child.status === "aborted");
}

export function renderSubagentChildren(
  card: HTMLElement,
  children: SubagentChildStatus[],
  onStopSubagentChild?: (stopId: string) => void,
): void {
  let list = card.querySelector<HTMLElement>(".agentic-chat-subagents");
  list ??= card.createDiv({ cls: "agentic-chat-subagents" });
  // ponytail: index-based identity assumes stable child order. Add keyed lookup if reordering is introduced.
  while (list.childElementCount < children.length) {
    list.createEl("details", { cls: "agentic-chat-subagent" });
  }
  while (list.childElementCount > children.length) {
    list.lastElementChild?.remove();
  }
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const childRow = list.children[i] as HTMLDetailsElement;
    childRow.className = `agentic-chat-subagent is-${child.status}`;
    childRow.open = child.status === "running";
    renderSubagentHeader(childRow, child, onStopSubagentChild);
    renderSubagentBody(childRow, child);
  }
  // Aggregate child state into ONE status pill on the step header so a card
  // never reads "stoppable" and "done" at the same time (Stop only ever
  // accompanies a still-running aggregate; done/failed have none).
  renderSubagentAggregate(card, children);
}

function renderSubagentAggregate(card: HTMLElement, children: SubagentChildStatus[]): void {
  // `card` is the step BODY; the status pill lives in the step HEADER, which is
  // a child of the step card (the body's parent).
  const header = card.parentElement?.querySelector<HTMLElement>(".agentic-chat-step-header");
  if (!header) return;
  let pill = header.querySelector<HTMLElement>(".agentic-chat-step-status");
  pill ??= header.createSpan({ cls: "agentic-chat-step-status" });
  const running = children.some((child) => child.status === "running");
  const queued = !running && children.some((child) => child.status === "queued");
  const failed = children.some((child) => child.status === "error");
  const stopped = !failed && children.some((child) => child.status === "aborted");
  let text: string;
  let stateClass: string;
  if (running) {
    text = "Running…";
    stateClass = "is-running";
  } else if (queued) {
    text = "Queued…";
    stateClass = "is-queued";
  } else if (failed) {
    text = "Failed";
    stateClass = "is-error";
  } else if (stopped) {
    text = "Stopped";
    stateClass = "is-error";
  } else {
    text = "Done";
    stateClass = "is-done";
  }
  pill.setText(text);
  pill.removeClass("is-running");
  pill.removeClass("is-done");
  pill.removeClass("is-error");
  pill.removeClass("is-queued");
  pill.addClass(stateClass);
}

function renderSubagentHeader(
  row: HTMLDetailsElement,
  child: SubagentChildStatus,
  onStopSubagentChild?: (stopId: string) => void,
): void {
  let summary = row.querySelector("summary");
  if (!summary) summary = row.createEl("summary");
  const nameText = `${String(child.agent ?? "?")}: ${truncateText(String(child.task ?? ""), 120)}`;
  const statusText = SUBAGENT_STATUS_LABEL[child.status] ?? String(child.status ?? "unknown");
  const metaText = subagentMetaText(child);
  const currentName = summary.querySelector<HTMLElement>(".agentic-chat-subagent-name")?.textContent;
  const currentStatus = summary.querySelector<HTMLElement>(".agentic-chat-subagent-status")?.textContent;
  const currentMeta = summary.querySelector<HTMLElement>(".agentic-chat-subagent-meta")?.textContent;
  // Absent meta renders as "" (queued/running); compare normalized so a
  // settled header with no meta isn't rebuilt on every live emit.
  if (currentName === nameText && currentStatus === statusText && (currentMeta ?? "") === metaText) return;
  summary.empty();
  summary.createSpan({ cls: "agentic-chat-subagent-name", text: nameText });
  summary.createSpan({ cls: "agentic-chat-subagent-status", text: statusText });
  // Small, subtle completion readout once the child settles: how long it ran,
  // how many tokens it used, and the approximate cost (when priced).
  if (metaText) {
    summary.createSpan({ cls: "agentic-chat-subagent-meta", text: metaText });
  }
  if (child.status === "running" && child.stopId && onStopSubagentChild) {
    const stopBtn = summary.createEl("button", { cls: "agentic-chat-subagent-stop", text: "Stop" });
    const id = child.stopId;
    stopBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onStopSubagentChild?.(id);
    });
  }
}

function subagentMetaText(child: SubagentChildStatus): string {
  if (child.status === "queued" || child.status === "running") return "";
  const parts: string[] = [];
  if (child.usage) {
    // Cost is a normalized field of its own — render it whenever positive,
    // even when the provider reported no token counts.
    if (child.usage.totalTokens > 0) parts.push(`${formatTokenInteger(child.usage.totalTokens)} tok`);
    if (child.usage.costUsd > 0) parts.push(formatCost(child.usage.costUsd));
  }
  if (child.durationMs !== undefined) parts.unshift(formatElapsed(child.durationMs));
  return parts.join(" · ");
}

function renderSubagentBody(row: HTMLDetailsElement, child: SubagentChildStatus): void {
  let pre = row.querySelector<HTMLPreElement>("pre");
  if (!pre) pre = row.createEl("pre");
  if (child.transcript && child.transcript.length > 0) {
    const rendered = Number(pre.dataset.rendered ?? "0");
    if (rendered < child.transcript.length) {
      for (let j = rendered; j < child.transcript.length; j++) {
        pre.appendText(formatTranscriptEntry(child.transcript[j]));
      }
      pre.dataset.rendered = String(child.transcript.length);
    }
  }
  if (child.status === "running") {
    delete pre.dataset.hasSummary;
  } else if (child.summary) {
    if (!pre.dataset.hasSummary) {
      pre.appendText("\n———\n");
      pre.appendText(truncateText(child.summary, 4_000));
      pre.dataset.hasSummary = "true";
    }
  }
}

function formatTranscriptEntry(entry: NonNullable<SubagentChildStatus["transcript"]>[number]): string {
  if (entry.type === "text") return entry.text;
  const marker = entry.status === "start" ? "▶" : entry.isError ? "✗" : "✓";
  if (entry.status === "start" && entry.args !== undefined) {
    const label = describeCall(entry.name, safeJson(entry.args));
    return `\n${marker} ${label}\n`;
  }
  return `\n${marker} ${entry.name}\n`;
}
