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

export interface SubagentChildViewOptions {
  /** A live view runs the row clock while the child runs; a replayed one shows the child's own time. */
  live: boolean;
  onStopSubagentChild?: (stopId: string) => void;
  /** Open a long report kept as an artifact (U5 #13). */
  onOpenReport?: (artifactId: string, title: string) => void;
  /** Load a stored child timeline (U5 #12): the live one is gone after a reload. */
  loadTimeline?: (artifactId: string) => Promise<SubagentTranscriptEntry[]>;
  onChange?: () => void;
}

/** The parts of a step row the child view fills in. */
export interface SubagentStepSlots {
  row: HTMLElement;
  icon: HTMLElement;
  head: HTMLElement;
  time: HTMLElement;
  detail: HTMLElement;
}

/**
 * One background child, drawn in its own `subagent` step row (U5 #2, #3): the
 * row's icon, clock, and Stop follow the child, not the dispatch call (which
 * returns at once). The row opens to the child's own timeline and report.
 * There is no separate "Subagents" section any more.
 */
export class SubagentChildView {
  private child: SubagentChildStatus | null = null;
  private readonly startedAt = performance.now();
  private timer: number | null = null;
  private readonly log: HTMLElement;
  private readonly stateEl: HTMLElement;
  private stopBtn: HTMLButtonElement | null = null;
  private timelineRequested = false;

  constructor(
    private readonly slots: SubagentStepSlots,
    private readonly options: SubagentChildViewOptions,
  ) {
    slots.row.addClass("is-subagent");
    this.stateEl = createSpan({ cls: "agentic-chat-subagent-status" });
    slots.time.before(this.stateEl);
    this.log = acHook(slots.detail.createDiv({ cls: "agentic-chat-subagent-log" }), "subagent-log");
  }

  /** The child id the row shows, if known. */
  get childId(): string | undefined {
    return this.child?.childId;
  }

  /**
   * A replayed row says "running" but no child of this chat runs it (a reload,
   * or a session saved while it ran): it can never settle, so it reads stopped.
   */
  markInterrupted(): void {
    if (!this.child || !this.isRunning) return;
    this.update({ ...this.child, status: "aborted", summary: "Stopped: the chat was reloaded or the session changed before it finished." });
  }

  /** The child is still running (its row spins; the turn may end without it). */
  get isRunning(): boolean {
    return this.child?.status === "running" || this.child?.status === "queued";
  }

  update(child: SubagentChildStatus): void {
    // A report or a replayed result may carry less (no live transcript): keep what the live view showed.
    const transcript = child.transcript ?? this.child?.transcript;
    this.child = { ...child, ...(transcript ? { transcript } : {}) };
    const status = this.child.status;
    const running = this.isRunning;
    this.slots.row.dataset.childStatus = status;
    this.slots.row.toggleClass("is-child-running", running);
    renderChildIcon(this.slots.icon, status);
    this.stateEl.setText(running ? "" : SUBAGENT_STATUS_LABEL[status] ?? String(status));
    this.renderStop();
    this.renderLog();
    this.maybeLoadTimeline();
    if (running && this.options.live && this.timer === null) {
      this.timer = window.setInterval(() => this.renderTime(), 1000);
    }
    if (!running && this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.renderTime();
    this.options.onChange?.();
  }

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private maybeLoadTimeline(): void {
    const child = this.child;
    const id = child?.timelineArtifactId;
    if (!child || !id || this.timelineRequested || this.isRunning || (child.transcript?.length ?? 0) > 0 || !this.options.loadTimeline) return;
    this.timelineRequested = true;
    this.options.loadTimeline(id).then(
      (entries) => {
        if (!this.child || (this.child.transcript?.length ?? 0) > 0) return;
        this.child = { ...this.child, transcript: entries };
        this.renderLog();
        this.options.onChange?.();
      },
      () => undefined,
    );
  }

  private renderTime(): void {
    const child = this.child;
    if (!child) return;
    const ms = child.durationMs ?? (this.isRunning && this.options.live ? performance.now() - this.startedAt : undefined);
    const cost = subagentMetaText(child);
    this.slots.time.setText([ms !== undefined && ms >= 1000 ? formatShortElapsed(ms) : "", cost].filter(Boolean).join(" · "));
  }

  private renderStop(): void {
    const child = this.child;
    const wanted = !!child && this.isRunning && !!child.stopId && !!this.options.onStopSubagentChild;
    if (!wanted) {
      this.stopBtn?.remove();
      this.stopBtn = null;
      return;
    }
    if (this.stopBtn) return;
    const id = child.stopId as string;
    const button = acHook(
      createEl("button", { cls: "agentic-chat-subagent-stop", text: "Stop", attr: { type: "button" } }),
      "subagent-stop",
    );
    button.setAttr("aria-label", `Stop subagent ${child.agent}`);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.options.onStopSubagentChild?.(id);
    });
    this.slots.time.after(button);
    this.stopBtn = button;
  }

  /** The child's own timeline: its text and one line per tool call, then its report. */
  private renderLog(): void {
    const child = this.child as SubagentChildStatus;
    const log = this.log;
    const entries = child.transcript ?? [];
    const rendered = Number(log.dataset.rendered ?? "0");
    for (let i = rendered; i < entries.length; i++) appendLogEntry(log, entries[i]);
    if (entries.length > rendered) log.dataset.rendered = String(entries.length);
    log.querySelector(".agentic-chat-subagent-report")?.remove();
    if (!this.isRunning && child.summary) {
      const el = acHook(log.createDiv({ cls: "agentic-chat-subagent-report" }), "subagent-report");
      el.createDiv({ cls: "agentic-chat-step-section-label", text: child.status === "done" ? "Report" : "Result" });
      el.createEl("pre", { text: truncateText(child.summary, 4_000) });
      const artifactId = child.artifactId;
      if (artifactId && this.options.onOpenReport) {
        const open = acHook(
          el.createEl("button", { cls: "agentic-chat-subagent-open-report", text: "Open full report", attr: { type: "button" } }),
          "subagent-open-report",
        );
        open.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.options.onOpenReport?.(artifactId, `${child.agent} report`);
        });
      }
    }
    if (log.childElementCount === 0 && this.isRunning) {
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
