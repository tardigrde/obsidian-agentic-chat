import { setIcon } from "obsidian";
import { SUBAGENT_TOOL_NAME } from "../tools/subagent-tool";
import { isAskUserDetails, middleEllipsis, SOURCE_TOOLS, activeNotePathFromText } from "./assistant-markdown";
import { callPath, formatElapsed, HIDE_RESULT_TOOLS, safeJson, truncateText } from "./format";
import { failedCount, runningLabel, stepRowParts, summarizeSteps, type StepStatus } from "./activity-summary";
import { renderAskUserStep, renderCallSection } from "./step-card";
import { renderSubagentChildren, subagentChildren, subagentResultForcesError } from "./subagent-tree";
import { acHook } from "./test-hooks";

/** The line's own state, from the status vocabulary. */
export type ActivityState = "running" | "needs-you" | "done" | "error";

export interface ActivityLineOptions {
  /** A live turn runs a timer; a replayed one shows no time. */
  live: boolean;
  onOpenNote?: (path: string) => void;
  onStopSubagentChild?: (stopId: string) => void;
  /** Called after the line changes height (scroll pinning). */
  onChange?: () => void;
}

interface StepEntry {
  id: string;
  name: string;
  rawArgs: string;
  status: StepStatus;
  startedAt: number;
  row: HTMLElement;
  icon: HTMLElement;
  time: HTMLElement;
  detail: HTMLElement;
  head: HTMLElement;
}

/**
 * The reasoning of one assistant message, shown as the first entries of the
 * activity body: `Thought for 3s: …`, folded to three lines.
 */
export class ReasoningEntry {
  private readonly label: HTMLElement;
  private readonly body: HTMLElement;
  private readonly startedAt = performance.now();

  constructor(readonly el: HTMLElement) {
    this.label = el.createSpan({ cls: "agentic-chat-thought-label", text: "Thinking…" });
    this.body = el.createSpan({ cls: "agentic-chat-thought-text" });
    el.addEventListener("click", () => el.toggleClass("is-expanded", !el.hasClass("is-expanded")));
    this.sync();
  }

  get text(): string {
    return this.body.textContent ?? "";
  }

  append(text: string): void {
    this.body.appendText(text);
    this.sync();
  }

  /** `Thought for 3s:`; a near-instant trace (history replay) shows `Thought:`. */
  settle(): void {
    const elapsed = performance.now() - this.startedAt;
    this.label.setText(elapsed < 1000 ? "Thought:" : `Thought for ${formatElapsed(elapsed)}:`);
    this.el.addClass("is-done");
  }

  remove(): void {
    this.el.remove();
  }

  private sync(): void {
    this.el.toggleClass("is-empty", !this.text.trim());
  }
}

/**
 * One line per turn: `[status] Read 4 notes, edited 1 · 1 failed  12s ›`.
 * Collapsed by default; the body holds the reasoning and one compact row per
 * tool call. Approvals render right below it (approvalSlot).
 */
export class ActivityLine {
  readonly el: HTMLElement;
  /** Where the inline approval card for this turn mounts. */
  readonly approvalSlot: HTMLElement;
  private readonly head: HTMLButtonElement;
  private readonly iconEl: HTMLElement;
  private readonly summaryEl: HTMLElement;
  private readonly stateEl: HTMLElement;
  private readonly failEl: HTMLElement;
  private readonly timeEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly reasoningEl: HTMLElement;
  private readonly stepsEl: HTMLElement;
  private readonly steps = new Map<string, StepEntry>();
  private readonly order: StepEntry[] = [];
  private readonly reasoning: ReasoningEntry[] = [];
  private readonly sourcePathsValue = new Set<string>();
  private readonly stepSourcePath = new Map<string, string>();
  private stateValue: ActivityState = "running";
  private needsYou = false;
  private open = false;
  private finished = false;
  private readonly startedAt = performance.now();
  private timer: number | null = null;
  private iconState: string | null = null;

  constructor(
    parent: HTMLElement,
    private readonly options: ActivityLineOptions,
  ) {
    this.el = acHook(parent.createDiv({ cls: "agentic-chat-activity" }), "activity");
    this.head = acHook(
      this.el.createEl("button", { cls: "agentic-chat-activity-head", attr: { type: "button", "aria-expanded": "false" } }),
      "activity-head",
    );
    this.iconEl = this.head.createSpan({ cls: "agentic-chat-status-icon", attr: { "aria-hidden": "true" } });
    this.summaryEl = this.head.createSpan({ cls: "agentic-chat-activity-summary" });
    // Its own span, outside the ellipsis: a long path must never cut "needs you".
    this.stateEl = this.head.createSpan({ cls: "agentic-chat-activity-state" });
    this.failEl = this.head.createSpan({ cls: "agentic-chat-activity-fail" });
    this.timeEl = this.head.createSpan({ cls: "agentic-chat-activity-time" });
    const chevron = this.head.createSpan({ cls: "agentic-chat-activity-chevron", attr: { "aria-hidden": "true" } });
    setIcon(chevron, "chevron-right");
    this.head.addEventListener("click", () => this.setOpen(!this.open));
    this.body = acHook(this.el.createDiv({ cls: "agentic-chat-activity-body" }), "activity-body");
    this.reasoningEl = this.body.createDiv({ cls: "agentic-chat-activity-thoughts" });
    this.stepsEl = this.body.createDiv({ cls: "agentic-chat-activity-steps" });
    this.approvalSlot = parent.createDiv({ cls: "agentic-chat-approval-slot" });
    if (options.live) {
      this.timer = window.setInterval(() => this.renderTime(), 1000);
    }
    this.refresh();
  }

  get state(): ActivityState {
    return this.stateValue;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Vault files read this turn (failed reads excluded): the turn's source chips. */
  get sourcePaths(): ReadonlySet<string> {
    return this.sourcePathsValue;
  }

  get stepCount(): number {
    return this.order.length;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.el.toggleClass("is-open", open);
    this.head.setAttr("aria-expanded", String(open));
    this.options.onChange?.();
  }

  addReasoning(): ReasoningEntry {
    const entry = new ReasoningEntry(this.reasoningEl.createDiv({ cls: "agentic-chat-thought" }));
    this.reasoning.push(entry);
    this.refresh();
    return entry;
  }

  /** The reasoning changed (a delta, a settle, a drop): update the head. */
  touch(): void {
    this.refresh();
  }

  startStep(id: string, name: string, rawArgs: string): void {
    const row = acHook(this.stepsEl.createDiv({ cls: ["agentic-chat-step", "is-running"] }), "step");
    row.setAttribute("data-ac-state", "running");
    const head = row.createDiv({ cls: "agentic-chat-step-head", attr: { role: "button", tabindex: "0", "aria-expanded": "false" } });
    const icon = head.createSpan({ cls: "agentic-chat-status-icon", attr: { "aria-hidden": "true" } });
    const parts = stepRowParts(name, rawArgs);
    head.createSpan({ cls: "agentic-chat-step-name", text: parts.verb });
    if (name.startsWith("mcp__")) head.setAttr("title", name);
    if (parts.arg) {
      const arg = head.createSpan({ cls: "agentic-chat-step-arg", text: parts.arg.length > 48 ? middleEllipsis(parts.arg, 48) : parts.arg });
      arg.setAttr("title", parts.arg);
      if (parts.path && this.options.onOpenNote) {
        arg.addClass("is-link");
        arg.setAttrs({ role: "link", tabindex: "0" });
        const open = (event: Event) => {
          event.preventDefault();
          event.stopPropagation();
          this.options.onOpenNote?.(parts.path);
        };
        arg.addEventListener("click", open);
        arg.addEventListener("keydown", (event) => {
          if (event.key === "Enter") open(event);
        });
      }
    }
    const time = head.createSpan({ cls: "agentic-chat-step-time" });
    const detail = row.createDiv({ cls: "agentic-chat-step-detail" });
    renderCallSection(detail, name, rawArgs);
    const toggle = () => this.toggleStep(entry);
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });
    const entry: StepEntry = { id, name, rawArgs, status: "running", startedAt: performance.now(), row, icon, time, detail, head };
    this.steps.set(id, entry);
    this.order.push(entry);
    this.syncStepIcon(entry);
    this.syncExpandable(entry);
    if (SOURCE_TOOLS.has(name)) {
      const path = callPath(rawArgs);
      if (path) {
        this.sourcePathsValue.add(path);
        this.stepSourcePath.set(id, path);
      }
    }
    this.refresh();
  }

  /** Live progress: a subagent tree (per-child stop) or an ask-user state. */
  updateStep(id: string, partial: unknown): void {
    const step = this.steps.get(id);
    if (!step) return;
    const details = (partial as { details?: unknown } | undefined)?.details;
    const children = subagentChildren(details);
    if (children.length > 0) {
      renderSubagentChildren(step.detail, children, this.options.onStopSubagentChild);
      // A running subagent needs its stop buttons in reach.
      this.setStepOpen(step, true);
      if (!this.open) this.setOpen(true);
    } else if (isAskUserDetails(details)) {
      renderAskUserStep(step.detail, details);
      this.setStepOpen(step, true);
    }
    this.syncExpandable(step);
    this.options.onChange?.();
  }

  endStep(id: string, result: string, isError: boolean, resultObject?: unknown): void {
    const step = this.steps.get(id);
    if (!step) return;
    const failed = isError || (step.name === SUBAGENT_TOOL_NAME && subagentResultForcesError(resultObject));
    if (step.name === SUBAGENT_TOOL_NAME) {
      const children = subagentChildren((resultObject as { details?: unknown } | undefined)?.details);
      if (children.length > 0) renderSubagentChildren(step.detail, children, this.options.onStopSubagentChild);
    }
    step.status = failed ? "error" : "done";
    step.row.removeClass("is-running");
    step.row.addClass(failed ? "is-error" : "is-done");
    step.row.setAttribute("data-ac-state", step.status);
    if (this.options.live) step.time.setText(formatElapsed(performance.now() - step.startedAt));
    this.syncStepIcon(step);
    if (!failed && step.name === "get_active_note") {
      const fromObject = resultObject !== undefined ? callPath(safeJson(resultObject)) : "";
      const path = fromObject || activeNotePathFromText(result);
      if (path) {
        this.sourcePathsValue.add(path);
        this.stepSourcePath.set(id, path);
      }
    }
    if (failed) {
      // A failed call is not a citation; its row opens to show why.
      const path = this.stepSourcePath.get(id);
      if (path) this.sourcePathsValue.delete(path);
      this.setStepOpen(step, true);
    }
    if (failed || !HIDE_RESULT_TOOLS.has(step.name)) {
      const section = step.detail.createDiv({ cls: "agentic-chat-step-result" });
      section.createDiv({ cls: "agentic-chat-step-section-label", text: failed ? "Error" : "Result" });
      section.createEl("pre", { text: truncateText(result, 4_000) });
    }
    this.syncExpandable(step);
    this.refresh();
  }

  /** An approval is waiting below the line: orange, `· needs you`, expanded. */
  setNeedsYou(needsYou: boolean): void {
    this.needsYou = needsYou;
    if (needsYou && !this.open) this.setOpen(true);
    this.refresh();
  }

  /** The turn ended. `error` marks a turn that ended in an error. */
  finish(options: { error?: boolean } = {}): void {
    if (this.finished) return;
    this.finished = true;
    this.needsYou = false;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    for (const step of this.order) {
      // A step without a result when the turn ends (stop, abort) did not finish.
      if (step.status === "running") {
        step.status = "error";
        step.row.removeClass("is-running");
        step.row.addClass("is-error");
        step.row.setAttribute("data-ac-state", "error");
        this.syncStepIcon(step);
      }
    }
    this.stateValue = options.error ? "error" : "done";
    this.refresh();
  }

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }

  private toggleStep(step: StepEntry): void {
    if (!step.row.hasClass("is-expandable")) return;
    this.setStepOpen(step, !step.row.hasClass("is-open"));
    this.options.onChange?.();
  }

  private setStepOpen(step: StepEntry, open: boolean): void {
    step.row.toggleClass("is-open", open);
    step.head.setAttr("aria-expanded", String(open));
  }

  private syncExpandable(step: StepEntry): void {
    step.row.toggleClass("is-expandable", step.detail.childElementCount > 0);
  }

  private syncStepIcon(step: StepEntry): void {
    renderStatusIcon(step.icon, step.status === "running" ? "running" : step.status);
  }

  private renderTime(): void {
    if (!this.options.live) return;
    this.timeEl.setText(formatShortElapsed(performance.now() - this.startedAt));
  }

  private refresh(): void {
    if (!this.finished) this.stateValue = this.needsYou ? "needs-you" : "running";
    const state = this.stateValue;
    this.el.setAttribute("data-ac-state", state);
    for (const name of ["running", "needs-you", "done", "error"]) this.el.toggleClass(`is-${name}`, state === name);
    if (this.iconState !== state) {
      this.iconState = state;
      renderStatusIcon(this.iconEl, state);
    }
    const steps = this.order.map((step) => ({ name: step.name, rawArgs: step.rawArgs, status: step.status }));
    const summary = summarizeSteps(steps);
    const running = [...this.order].reverse().find((step) => step.status === "running");
    let text: string;
    if (state === "needs-you") text = summary || (running ? runningLabel(running.name, running.rawArgs) : "Waiting");
    else if (state === "running") text = running ? runningLabel(running.name, running.rawArgs) : summary || "Thinking…";
    else text = summary || (this.reasoning.some((entry) => entry.text.trim()) ? "Thought" : "");
    this.summaryEl.setText(text);
    this.stateEl.setText(state === "needs-you" ? "· needs you" : "");
    const failed = failedCount(steps);
    this.failEl.setText(failed > 0 ? `· ${failed} failed` : "");
    this.renderTime();
    // A finished turn with no tool call and no reasoning has nothing to show.
    const empty = this.finished && this.order.length === 0 && !this.reasoning.some((entry) => entry.text.trim());
    this.el.toggleClass("is-hidden", empty);
    this.options.onChange?.();
  }
}

/** One icon per status: spinner, hand, check, alert. */
export function renderStatusIcon(el: HTMLElement, state: ActivityState | StepStatus): void {
  el.empty();
  el.removeClasses(["is-running", "is-needs-you", "is-done", "is-error"]);
  el.addClass(`is-${state}`);
  if (state === "running") {
    el.createSpan({ cls: "agentic-chat-spinner" });
    return;
  }
  setIcon(el, state === "needs-you" ? "hand" : state === "done" ? "check-circle-2" : "alert-circle");
}

/** `12s`, `1m 4s`: the activity line's clock. */
export function formatShortElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
