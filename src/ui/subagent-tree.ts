import { setIcon } from "obsidian";
import type { SubagentChildStatus, SubagentTranscriptEntry } from "../tools/subagent-tool";
import { describeCall, formatCost, formatShortElapsed, safeJson, truncateText } from "./format";
import { acHook } from "./test-hooks";

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

/** `Subagents · 1 running`, `Subagents · 2 done · 1 failed · 1 stopped`. */
export function subagentBlockSummary(children: readonly SubagentChildStatus[]): string {
  const count = (...statuses: SubagentChildStatus["status"][]) => children.filter((child) => statuses.includes(child.status)).length;
  const parts = ["Subagents"];
  for (const [n, label] of [
    [count("running", "queued"), "running"],
    [count("done"), "done"],
    [count("error"), "failed"],
    [count("aborted"), "stopped"],
  ] as const) {
    if (n > 0) parts.push(`${n} ${label}`);
  }
  return parts.join(" · ");
}

export interface SubagentBlockOptions {
  /** A live block runs a clock while a child runs; a replayed one shows the children's own times. */
  live: boolean;
  onStopSubagentChild?: (stopId: string) => void;
  onChange?: () => void;
}

interface ChildRow {
  el: HTMLDetailsElement;
  startedAt: number;
}

/**
 * The subagents of one timeline segment, in a section of their own (U4 #5):
 * `Subagents · 1 running · 23s`, collapsed by default (also when done). One
 * row per child: agent, task, status, time, cost, and Stop while it runs. A
 * row opens the child's own timeline.
 */
export class SubagentBlock {
  readonly el: HTMLElement;
  private readonly head: HTMLButtonElement;
  private readonly iconEl: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private readonly timeEl: HTMLElement;
  private readonly list: HTMLElement;
  /** Dispatch step id -> its children, in dispatch order. */
  private readonly dispatches = new Map<string, SubagentChildStatus[]>();
  private readonly rows = new Map<string, ChildRow>();
  private readonly startedAt = performance.now();
  private settledMs: number | null = null;
  private open = false;
  private timer: number | null = null;

  constructor(
    anchor: HTMLElement,
    private readonly options: SubagentBlockOptions,
  ) {
    this.el = acHook(createDiv({ cls: "agentic-chat-subagent-block" }), "subagents");
    anchor.after(this.el);
    this.head = acHook(
      this.el.createEl("button", { cls: "agentic-chat-subagent-block-head", attr: { type: "button", "aria-expanded": "false" } }),
      "subagents-head",
    );
    this.iconEl = this.head.createSpan({ cls: "agentic-chat-status-icon", attr: { "aria-hidden": "true" } });
    setIcon(this.iconEl, "bot");
    this.summaryEl = this.head.createSpan({ cls: "agentic-chat-subagent-block-summary" });
    this.timeEl = this.head.createSpan({ cls: "agentic-chat-subagent-block-time" });
    const chevron = this.head.createSpan({ cls: "agentic-chat-activity-chevron", attr: { "aria-hidden": "true" } });
    setIcon(chevron, "chevron-right");
    this.head.addEventListener("click", () => this.setOpen(!this.open));
    this.list = this.el.createDiv({ cls: "agentic-chat-subagents" });
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.el.toggleClass("is-open", open);
    this.head.setAttr("aria-expanded", String(open));
    this.options.onChange?.();
  }

  /** A dispatch reported its children (a live tick or the final result). */
  update(stepId: string, children: SubagentChildStatus[]): void {
    this.dispatches.set(stepId, children);
    children.forEach((child, index) => this.renderRow(`${stepId}:${index}`, child));
    // A shorter list than the last report: drop the rows it no longer has.
    for (const [key, row] of this.rows) {
      const [owner, index] = [key.slice(0, key.lastIndexOf(":")), Number(key.slice(key.lastIndexOf(":") + 1))];
      if (owner === stepId && index >= children.length) {
        row.el.remove();
        this.rows.delete(key);
      }
    }
    this.refresh();
  }

  /** The turn ended: stop the clock. */
  finish(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private allChildren(): SubagentChildStatus[] {
    return [...this.dispatches.values()].flat();
  }

  private refresh(): void {
    const children = this.allChildren();
    const running = children.some((child) => child.status === "running" || child.status === "queued");
    const failed = children.some((child) => child.status === "error" || child.status === "aborted");
    const state = running ? "running" : failed ? "error" : "done";
    this.el.setAttribute("data-ac-state", state);
    this.summaryEl.setText(subagentBlockSummary(children));
    if (running && this.options.live && this.timer === null) {
      this.timer = window.setInterval(() => this.renderTime(), 1000);
    }
    if (!running) {
      if (this.timer !== null) window.clearInterval(this.timer);
      this.timer = null;
      if (this.settledMs === null) {
        const longest = Math.max(0, ...children.map((child) => child.durationMs ?? 0));
        this.settledMs = this.options.live ? Math.max(longest, performance.now() - this.startedAt) : longest;
      }
    } else {
      this.settledMs = null;
    }
    this.renderTime();
    this.options.onChange?.();
  }

  private renderTime(): void {
    const ms = this.settledMs ?? (this.options.live ? performance.now() - this.startedAt : 0);
    this.timeEl.setText(ms >= 1000 ? `· ${formatShortElapsed(ms)}` : "");
    if (!this.options.live) return;
    for (const row of this.rows.values()) {
      if (row.el.dataset.status !== "running") continue;
      row.el.querySelector<HTMLElement>(".agentic-chat-subagent-time")?.setText(formatShortElapsed(performance.now() - row.startedAt));
    }
  }

  private renderRow(key: string, child: SubagentChildStatus): void {
    let row = this.rows.get(key);
    if (!row) {
      const el = acHook(this.list.createEl("details", { cls: "agentic-chat-subagent" }), "subagent-row");
      el.createEl("summary");
      el.createDiv({ cls: "agentic-chat-subagent-log" });
      el.addEventListener("toggle", () => this.options.onChange?.());
      row = { el, startedAt: performance.now() };
      this.rows.set(key, row);
    }
    row.el.dataset.status = child.status;
    row.el.className = `agentic-chat-subagent is-${child.status}`;
    this.renderRowHead(row, child);
    this.renderRowLog(row.el, child);
  }

  private renderRowHead(row: ChildRow, child: SubagentChildStatus): void {
    const summary = row.el.querySelector("summary") as HTMLElement;
    const stop = child.status === "running" && !!child.stopId && !!this.options.onStopSubagentChild;
    const signature = [child.agent, child.task, child.status, child.durationMs ?? "", child.usage?.costUsd ?? "", stop].join("|");
    if (summary.dataset.signature === signature) return;
    summary.dataset.signature = signature;
    summary.empty();
    const icon = summary.createSpan({ cls: "agentic-chat-status-icon", attr: { "aria-hidden": "true" } });
    renderChildIcon(icon, child.status);
    summary.createSpan({ cls: "agentic-chat-subagent-name", text: String(child.agent ?? "?") });
    const task = String(child.task ?? "").replace(/\s+/g, " ");
    const taskEl = summary.createSpan({ cls: "agentic-chat-subagent-task", text: truncateText(task, 120) });
    taskEl.setAttr("title", task);
    summary.createSpan({ cls: "agentic-chat-subagent-status", text: SUBAGENT_STATUS_LABEL[child.status] ?? String(child.status) });
    const meta = subagentMetaText(child);
    summary.createSpan({
      cls: "agentic-chat-subagent-time",
      text: child.durationMs !== undefined ? formatShortElapsed(child.durationMs) : child.status === "running" && this.options.live ? formatShortElapsed(performance.now() - row.startedAt) : "",
    });
    if (meta) summary.createSpan({ cls: "agentic-chat-subagent-meta", text: meta });
    if (stop) {
      const stopBtn = summary.createEl("button", { cls: "agentic-chat-subagent-stop", text: "Stop", attr: { type: "button" } });
      stopBtn.setAttr("aria-label", `Stop subagent ${child.agent}`);
      const id = child.stopId as string;
      stopBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.options.onStopSubagentChild?.(id);
      });
    }
  }

  /** The child's own timeline: its text and one line per tool call, then its report. */
  private renderRowLog(row: HTMLDetailsElement, child: SubagentChildStatus): void {
    const log = row.querySelector<HTMLElement>(".agentic-chat-subagent-log") as HTMLElement;
    const entries = child.transcript ?? [];
    const rendered = Number(log.dataset.rendered ?? "0");
    for (let i = rendered; i < entries.length; i++) appendLogEntry(log, entries[i]);
    if (entries.length > rendered) log.dataset.rendered = String(entries.length);
    const report = log.querySelector<HTMLElement>(".agentic-chat-subagent-report");
    if (child.status === "running" || child.status === "queued") {
      report?.remove();
    } else if (child.summary && !report) {
      const el = log.createDiv({ cls: "agentic-chat-subagent-report" });
      el.createDiv({ cls: "agentic-chat-step-section-label", text: child.status === "done" ? "Report" : "Result" });
      el.createEl("pre", { text: truncateText(child.summary, 4_000) });
    }
    if (log.childElementCount === 0 && child.status === "running") {
      log.createDiv({ cls: "agentic-chat-subagent-empty", text: "Starting…" });
    } else if (log.childElementCount > 1) {
      log.querySelector(".agentic-chat-subagent-empty")?.remove();
    }
  }
}

function appendLogEntry(log: HTMLElement, entry: SubagentTranscriptEntry): void {
  log.querySelector(".agentic-chat-subagent-empty")?.remove();
  if (entry.type === "text") {
    if (entry.text.trim()) log.createDiv({ cls: "agentic-chat-subagent-text", text: entry.text });
    return;
  }
  if (entry.status === "end") {
    // The newest still-running line for this tool settles.
    const open = Array.from(log.querySelectorAll<HTMLElement>(".agentic-chat-subagent-tool.is-running")).filter(
      (line) => line.dataset.tool === entry.name,
    );
    const line = open.at(0);
    if (line) {
      line.removeClass("is-running");
      line.addClass(entry.isError ? "is-error" : "is-done");
      renderChildIcon(line.querySelector<HTMLElement>(".agentic-chat-status-icon") as HTMLElement, entry.isError ? "error" : "done");
    }
    return;
  }
  const line = log.createDiv({ cls: ["agentic-chat-subagent-tool", "is-running"] });
  line.dataset.tool = entry.name;
  renderChildIcon(line.createSpan({ cls: "agentic-chat-status-icon", attr: { "aria-hidden": "true" } }), "running");
  line.createSpan({ cls: "agentic-chat-subagent-tool-label", text: describeCall(entry.name, safeJson(entry.args ?? {})) });
}

function renderChildIcon(el: HTMLElement, status: SubagentChildStatus["status"]): void {
  el.empty();
  el.removeClasses(["is-running", "is-done", "is-error", "is-needs-you"]);
  if (status === "running" || status === "queued") {
    el.addClass("is-running");
    el.createSpan({ cls: "agentic-chat-spinner" });
    return;
  }
  const ok = status === "done";
  el.addClass(ok ? "is-done" : "is-error");
  setIcon(el, ok ? "check-circle-2" : "alert-circle");
}

function subagentMetaText(child: SubagentChildStatus): string {
  if (child.status === "queued" || child.status === "running") return "";
  if (child.usage && child.usage.costUsd > 0) return formatCost(child.usage.costUsd);
  return "";
}
