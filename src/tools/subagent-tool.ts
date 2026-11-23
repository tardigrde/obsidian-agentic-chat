import { type Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { findAgentRole, type AgentRole } from "../agent/subagents";
import { sumAssistantUsage } from "../agent/usage";
import { redactText, redactValue } from "../privacy/redaction";
import { truncateToolOutput } from "../vault/truncate";
import { toolResult, untrustedToolResult } from "./result";
import { errorMessage } from "../utils/errors";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";

export const SUBAGENT_TOOL_NAME = "subagent";

/** Default cap on how many Dispatch calls run concurrently in one parent turn (setting `maxParallelSubagents`). */
const DEFAULT_CONCURRENCY = 10;
/** Finished children kept per chat tab for `action: "continue"`; the oldest is dropped. */
export const MAX_RETAINED_CHILDREN = 10;
/** At most this many files a child read are cited under the parent's answer. */
const MAX_CHILD_SOURCES = 20;
/** Child tools whose `path` is a note the child read (its sources). */
const CHILD_SOURCE_TOOLS = new Set(["read"]);
/** Per-child summary cap (characters) fed into the parent's context. */
const PER_CHILD_SUMMARY_CHARS = 8_000;
/**
 * How much of a long report the chat shows the user. The model gets none of
 * it, only the artifact pointer, so it never pays for the same text twice.
 */
const REPORT_PREVIEW_CHARS = 3_500; // under the row's 4,000-char cut (subagent-tree.ts)

/** Single line in a child's live transcript. */
export type SubagentTranscriptEntry =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; status: "start" | "end"; args?: unknown; isError?: boolean };

/** Live status of one dispatched child, streamed to the UI and returned as details. */
export interface SubagentChildStatus {
  agent: string;
  task: string;
  status: "queued" | "running" | "done" | "error" | "aborted";
  /** Final summary text (or the error message) once the child settles. */
  summary?: string;
  /** Id used to abort just this child (its child id). */
  stopId?: string;
  /** The child id the model uses for continue/stop (`sa-3`). */
  childId?: string;
  /** A long report kept whole: the artifact id the user can open. */
  artifactId?: string;
  /** Vault files the child read (U5 #14): the parent's answer cites them. */
  sources?: string[];
  /** The child's compact timeline, kept as an artifact so the row shows it after a reload (U5 #12). */
  timelineArtifactId?: string;
  /** Live transcript accumulated while the child runs. */
  transcript?: SubagentTranscriptEntry[];
  /** Wall-clock runtime of the child session, set once it settles. */
  durationMs?: number;
  /** Token/cost usage of the child session, set when the provider reports it. */
  usage?: { input: number; output: number; totalTokens: number; costUsd: number };
}

/** Structured details payload for the subagent tool result, consumed by the UI. */
export interface SubagentDetails {
  kind: "subagent";
  children: SubagentChildStatus[];
}

/** A finished child kept for a follow-up (`action: "continue"`). */
export interface RetainedChild {
  id: string;
  agent: string;
  child: Agent;
}

/**
 * Per-service subagent state: live stop hooks, error details awaiting the
 * tool-call controller, and retained children. Each `AgentSubagentRuntime`
 * (and therefore each chat service) owns one, so equal tool-call ids in
 * different services never collide.
 */
export class SubagentRegistry {
  private readonly activeStops = new Map<string, () => void>();
  /** Why a child was stopped, when it was not the user (the spend cap, a session change). */
  private readonly stopReasons = new Map<string, string>();
  private readonly pendingErrorDetails = new Map<string, SubagentDetails>();
  private readonly retained = new Map<string, RetainedChild>();
  /** Bumped when the session is cleared or replaced: a child from before never reports into the new one. */
  private gen = 0;

  get generation(): number {
    return this.gen;
  }

  /** Children running in the background, by child id (U5 #1). */
  private readonly running = new Map<string, SubagentChildStatus>();
  private childCounter = 0;

  markRunning(id: string, status: SubagentChildStatus): void {
    this.running.set(id, status);
  }

  markSettled(id: string): void {
    this.running.delete(id);
  }

  isRunning(id: string): boolean {
    return this.running.has(id.trim());
  }

  get runningCount(): number {
    return this.running.size;
  }

  runningChildren(): SubagentChildStatus[] {
    return [...this.running.values()];
  }

  retainedIds(): string[] {
    return [...this.retained.keys()];
  }

  /**
   * Stop every running child. A child belongs to its tab's agent: closing the
   * tab, loading another session in it, or a reload stops its children.
   */
  abortAll(reason?: string): void {
    for (const id of [...this.activeStops.keys()]) this.abort(id, reason);
    this.activeStops.clear();
  }

  /** A fresh child id (`sa-3`): short, so the model copies it reliably. */
  nextChildId(): string {
    this.childCounter += 1;
    return `sa-${this.childCounter}`;
  }

  /** Keep a child for later follow-ups; the oldest beyond the limit is dropped. */
  retain(entry: RetainedChild): void {
    this.retained.delete(entry.id);
    this.retained.set(entry.id, entry);
    while (this.retained.size > MAX_RETAINED_CHILDREN) {
      const oldest = this.retained.keys().next().value;
      if (oldest === undefined) break;
      this.retained.delete(oldest);
    }
  }

  retainedChild(id: string): RetainedChild | undefined {
    return this.retained.get(id.trim());
  }

  /** The role of a retained child, for the approval gate of a continue call. */
  retainedAgent(id: string): string | undefined {
    return this.retainedChild(id)?.agent;
  }

  get retainedCount(): number {
    return this.retained.size;
  }

  /** The active session changed: its children may not be continued from another one. */
  clearRetained(): void {
    this.retained.clear();
  }

  setActiveStop(id: string, stop: () => void): void {
    this.activeStops.set(id, stop);
  }

  deleteActiveStop(id: string): void {
    this.activeStops.delete(id);
  }

  /** Stop one child by id. Other services with the same id are untouched. */
  abort(id: string, reason?: string): void {
    if (reason && this.activeStops.has(id)) this.stopReasons.set(id, reason);
    this.activeStops.get(id)?.();
    this.activeStops.delete(id);
  }

  /** The reason a stopped child settles with; "Stopped by user" when none was given. */
  takeStopReason(id: string): string {
    const reason = this.stopReasons.get(id);
    this.stopReasons.delete(id);
    return reason ?? "Stopped by user";
  }

  setPendingErrorDetails(id: string, details: SubagentDetails): void {
    this.pendingErrorDetails.set(id, details);
  }

  takePendingErrorDetails(id: string): SubagentDetails | undefined {
    const details = this.pendingErrorDetails.get(id);
    if (details) this.pendingErrorDetails.delete(id);
    return details;
  }

  clearPendingErrorDetails(id?: string): void {
    if (id) this.pendingErrorDetails.delete(id);
    else this.pendingErrorDetails.clear();
  }

  /** Drop all state. Used when a session is cleared or replaced: running children stop first. */
  clear(): void {
    this.gen += 1;
    this.abortAll();
    this.running.clear();
    this.pendingErrorDetails.clear();
    this.retained.clear();
  }

  get pendingErrorCount(): number {
    return this.pendingErrorDetails.size;
  }

  get activeStopCount(): number {
    return this.activeStops.size;
  }
}

/**
 * Persisted shape strips volatile live fields (`transcript`/`stopId`) to keep
 * JSONL bounded and redacts high-entropy secrets. Live `snapshot` retains
 * them for streaming UI; persisted `persistedSnapshot` is what lands in
 * `toolResult.details` for reload. Both shapes are accepted by
 * `subagentChildren`/`renderSubagentBody`. Allowlist prevents future volatile
 * fields from leaking.
 */
export function toPersistedChild(status: SubagentChildStatus): SubagentChildStatus {
  return {
    agent: redactText(String(status.agent ?? ""), { redactHighEntropy: true, maxLength: 120 }),
    task: redactText(String(status.task ?? ""), { redactHighEntropy: true, maxLength: 400 }),
    status: status.status,
    ...(status.summary ? { summary: redactText(status.summary, { redactHighEntropy: true, maxLength: 9000 }) } : {}),
    ...(typeof status.durationMs === "number" ? { durationMs: status.durationMs } : {}),
    ...(status.usage ? { usage: status.usage } : {}),
    // Kept on reload: the row's child id and its "Open full report" link (U5 #13).
    ...(status.childId ? { childId: String(status.childId).slice(0, 40) } : {}),
    ...(status.artifactId ? { artifactId: String(status.artifactId).slice(0, 120) } : {}),
    ...(status.timelineArtifactId ? { timelineArtifactId: String(status.timelineArtifactId).slice(0, 120) } : {}),
    ...(status.sources?.length ? { sources: status.sources.slice(0, MAX_CHILD_SOURCES).map((path) => String(path).slice(0, 300)) } : {}),
  };
}

export function persistedSnapshot(statuses: SubagentChildStatus[]): SubagentDetails {
  return { kind: "subagent", children: statuses.map(toPersistedChild) };
}

export interface SubagentToolDeps {
  /** The subagent roles available to dispatch right now. */
  getProfiles: () => AgentRole[];
  /** Build a ready-to-run child Agent for a role (tools/model/stream wired by the caller). */
  createChildAgent: (profile: AgentRole) => Agent;
  /**
   * Report a child's token usage for session cost accounting, once per child
   * model call, so the spend cap sees a running fan-out (U4 #9).
   */
  recordUsage?: (usage: Usage, dispatchId: string) => void;
  /** How many children run at once (setting `maxParallelSubagents`); default 10. */
  maxParallel?: () => number;
  /** Per-service registry. Omit only for standalone tools that need no external stop. */
  registry?: SubagentRegistry;
  /** Keeps a report longer than the inline cap in full, readable with the artifact tool. */
  artifactStore?: ToolArtifactStoreLike;
  /** Background delivery: live row updates and the settled report. */
  background?: SubagentBackgroundHooks;
}

export interface SubagentTask {
  agent: string;
  task: string;
}

/**
 * Resolve the single requested task, tolerating malformed model output (blank
 * agent/task collapse to no-op). Retained for approval gating, which inspects
 * the role of the target agent before the dispatch runs. Stop and status are
 * not dispatches.
 */
export function normalizeTasks(
  params: { agent?: string; task?: string; action?: string; id?: string },
  retainedAgent?: (id: string) => string | undefined,
): SubagentTask[] {
  if (params.action === "stop" || params.action === "status") return [];
  // A continue call runs the role of the child it continues.
  const agent = params.action === "continue" ? (params.id ? retainedAgent?.(params.id) : undefined) : params.agent?.trim();
  const task = params.task?.trim();
  if (agent && task) return [{ agent, task }];
  return [];
}

/** A settled child, handed to the parent as an event (U5 #1). */
export interface SubagentReport {
  childId: string;
  agent: string;
  task: string;
  /** The `subagent` call that started this run; the UI row belongs to it. */
  toolCallId: string;
  /** Persisted child status (no live transcript). */
  details: SubagentDetails;
  /** What the model reads: the report, the error, or the stop notice. */
  text: string;
}

/** How a background child reaches the parent after its dispatch call returned. */
export interface SubagentBackgroundHooks {
  /** Live status of a running child, for its row in the activity block. */
  onChildUpdate?: (toolCallId: string, details: SubagentDetails) => void;
  /** The child settled (done, error, or stopped): give the report to the parent. */
  deliverReport: (report: SubagentReport) => void;
}

const SubagentParameters = Type.Object({
  action: Type.Optional(
    Type.Union([Type.Literal("start"), Type.Literal("continue"), Type.Literal("stop"), Type.Literal("status")], {
      description: "default start",
    }),
  ),
  agent: Type.Optional(Type.String({ description: "role name (start)" })),
  task: Type.Optional(Type.String({ description: "task (start), or the follow-up (continue)" })),
  id: Type.Optional(Type.String({ description: "child id (continue, stop)" })),
});

/**
 * The `subagent` dispatch tool. Children run in the background (U5 #1): a
 * start or continue call returns at once with the child id, the parent turn
 * goes on (or ends), and the user can keep talking. When the child settles,
 * `deliverReport` hands its report to the parent as a `<subagent_report>`
 * message. The parent's Stop does not stop a child; each child stops on its
 * own (its row's stop button, or `{action: "stop", id}`). At most
 * `maxParallelSubagents` children run at once per chat; a call over the limit
 * fails and says so.
 */
export function createSubagentTool(
  deps: SubagentToolDeps,
): AgentTool<typeof SubagentParameters, SubagentDetails> {
  const registry = deps.registry ?? new SubagentRegistry();
  const limit = (): number => Math.max(1, Math.trunc(deps.maxParallel?.() ?? DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY);
  return {
    name: SUBAGENT_TOOL_NAME,
    label: "Dispatch subagent",
    description:
      "Start a specialist subagent in the background (isolated context). It returns a child id at once; " +
      "its report arrives later as a <subagent_report> message: do not wait, poll, or repeat the task. " +
      `One call = one subagent {agent, task}; up to ${limit()} run at once. ` +
      'Follow up: {action: "continue", id, task}. Stop: {action: "stop", id}. List: {action: "status"}.',
    parameters: SubagentParameters,
    execute: async (toolCallId, params) => {
      const action = params.action ?? "start";
      if (action === "status") return statusResult(registry);
      if (action === "stop") return stopResult(registry, params.id);

      const task = params.task?.trim();
      const continuing = action === "continue";
      let agent = params.agent?.trim();
      let retained: RetainedChild | undefined;
      let profile: AgentRole | undefined;
      if (continuing) {
        const id = params.id?.trim() ?? "";
        if (id && registry.isRunning(id)) {
          throw new Error(`subagent: child "${id}" is still running. Wait for its report, or stop it with {action: "stop", id: "${id}"}.`);
        }
        retained = id ? registry.retainedChild(id) : undefined;
        if (!retained) {
          throw new Error(
            `subagent: no child with id "${id}" to continue (children are kept for this chat tab, the last ${MAX_RETAINED_CHILDREN}). Start a new one with {agent, task}.`,
          );
        }
        agent = retained.agent;
        if (!task) throw new Error('subagent: continue needs a follow-up task: {action: "continue", id, task}.');
      } else {
        if (!agent || !task) throw new Error("subagent: provide both {agent, task}.");
        const profiles = deps.getProfiles();
        profile = findAgentRole(profiles, agent);
        if (!profile) {
          const available = profiles.map((candidate) => candidate.name).join(", ") || "(none)";
          throw new Error(`subagent: unknown agent "${agent.trim()}". Available: ${available}.`);
        }
      }
      if (!agent || !task) throw new Error("subagent: provide both {agent, task}.");
      const max = limit();
      if (registry.runningCount >= max) {
        throw new Error(
          `subagent: at most ${max} subagents run at once in this chat, and ${registry.runningCount} are running. ` +
            'Wait for a report, or stop one with {action: "stop", id}.',
        );
      }

      const childId = retained?.id ?? registry.nextChildId();
      const child = retained?.child ?? deps.createChildAgent(profile as AgentRole);
      const status: SubagentChildStatus = { agent, task, status: "running", childId, stopId: childId };
      registry.markRunning(childId, status);
      runInBackground(deps, registry, { childId, agent, task, toolCallId, child, status }).catch((error: unknown) => {
        console.warn("Agentic Chat: a background subagent failed to settle.", error);
      });

      return untrustedToolResult(
        `Started subagent "${agent}" as ${childId}. It runs in the background; its report arrives later as a <subagent_report id="${childId}"> message. ` +
          "Do not wait, poll, or start the same task again. Continue with other work, or end your turn.",
        snapshot([status]),
        "subagent",
      );
    },
  };
}

interface BackgroundRun {
  childId: string;
  agent: string;
  task: string;
  toolCallId: string;
  child: Agent;
  status: SubagentChildStatus;
}

/**
 * Run one child to the end, keep it for a follow-up, and deliver its report.
 * Whatever fails on the way (the child, an artifact write, a row update), the
 * child is settled and its report delivered: the parent never waits for a
 * report that does not come (review of #431).
 */
async function runInBackground(deps: SubagentToolDeps, registry: SubagentRegistry, run: BackgroundRun): Promise<void> {
  const { status } = run;
  const generation = registry.generation;
  let emitTimer: number | null = null;
  const emit = (): void => {
    try {
      deps.background?.onChildUpdate?.(run.toolCallId, snapshot([status]));
    } catch (error) {
      console.warn("Agentic Chat: a subagent row update failed.", error);
    }
  };
  const scheduleEmit = (): void => {
    if (emitTimer) return;
    emitTimer = window.setTimeout(() => {
      emitTimer = null;
      emit();
    }, 150);
  };
  let fullReport: string | undefined;
  let modelText: string | undefined;
  try {
    fullReport = await runSingleChild(deps, registry, status, run.child, run.task, run.childId, undefined, scheduleEmit);
  } catch (error) {
    status.status = "error";
    status.summary = redactText(truncateToolOutput(errorMessage(error), PER_CHILD_SUMMARY_CHARS), {
      redactHighEntropy: true,
      maxLength: 9000,
    });
  }
  if (emitTimer) {
    window.clearTimeout(emitTimer);
    emitTimer = null;
  }
  try {
    if (fullReport !== undefined && fullReport.length > PER_CHILD_SUMMARY_CHARS) {
      const kept = await keepFullReport(deps.artifactStore, run.agent, fullReport);
      if (kept) {
        status.summary = kept.userPreview;
        status.artifactId = kept.artifactId;
        modelText = kept.modelText;
      }
    }
    const timelineId = await keepTimeline(deps.artifactStore, run.agent, status.transcript);
    if (timelineId) status.timelineArtifactId = timelineId;
  } catch (error) {
    // The report goes out with its truncated summary.
    console.warn("Agentic Chat: could not store a subagent report or timeline.", error);
  }
  // The session was cleared or replaced while this child ran: it belongs to no conversation now.
  if (registry.generation !== generation) return;
  // Kept for a follow-up in settle order, so the last ten reported children stay continuable.
  registry.retain({ id: run.childId, agent: run.agent, child: run.child });
  registry.markSettled(run.childId);
  emit();
  const body =
    status.status === "error"
      ? `Subagent "${run.agent}" failed: ${status.summary ?? "unknown error"}`
      : status.status === "aborted"
        ? `Subagent "${run.agent}" was stopped before it finished. Do not start the same task again unless the user asks.`
        : modelText ?? status.summary ?? "(no output)";
  const followUp =
    status.status === "aborted"
      ? ""
      : `\n\n[To follow up with this subagent, call subagent with {action: "continue", id: "${run.childId}", task}.]`;
  deps.background?.deliverReport({
    childId: run.childId,
    agent: run.agent,
    task: run.task,
    toolCallId: run.toolCallId,
    details: persistedSnapshot([status]),
    text: `${body}${followUp}`,
  });
}

/** Most timeline entries kept for a reload; the live row shows all of them. */
const MAX_TIMELINE_ENTRIES = 200;

/**
 * The child's timeline is live-only in the row; it is stored as a compact
 * artifact (tool lines and text, no tool results) so the row can show it
 * again after a reload. The model never reads it. Null without a store.
 */
async function keepTimeline(
  store: ToolArtifactStoreLike | undefined,
  agent: string,
  transcript: SubagentTranscriptEntry[] | undefined,
): Promise<string | null> {
  if (!store || !transcript || transcript.length === 0) return null;
  const merged: SubagentTranscriptEntry[] = [];
  for (const entry of transcript) {
    const last = merged.at(-1);
    if (entry.type === "text" && last?.type === "text") last.text += entry.text;
    else merged.push(entry.type === "text" ? { ...entry } : { type: "tool", name: entry.name, status: entry.status, ...(entry.args !== undefined ? { args: entry.args } : {}), ...(entry.isError ? { isError: true } : {}) });
  }
  try {
    const artifact = await store.writeArtifact({
      label: `${agent} subagent timeline`,
      sourceToolName: SUBAGENT_TOOL_NAME,
      text: JSON.stringify(redactValueForTimeline(merged.slice(-MAX_TIMELINE_ENTRIES))),
      contentType: "application/json",
    });
    return artifact.id;
  } catch {
    return null;
  }
}

function redactValueForTimeline(entries: SubagentTranscriptEntry[]): SubagentTranscriptEntry[] {
  return entries.map((entry) => {
    if (entry.type === "text") return { type: "text", text: redactText(entry.text, { redactHighEntropy: true, maxLength: 4_000 }) };
    if (entry.args === undefined) return entry;
    return { ...entry, args: redactValue(entry.args, { redactHighEntropy: true, maxLength: 500, maxDepth: 4, maxArrayLength: 20, maxObjectKeys: 20 }) };
  });
}

function statusResult(registry: SubagentRegistry) {
  const running = registry.runningChildren();
  const lines = running.map((child) => `- ${child.childId}: ${child.agent} (running) — ${child.task.slice(0, 120)}`);
  const kept = registry.retainedIds().filter((id) => !registry.isRunning(id));
  if (kept.length > 0) lines.push(`Finished, can be continued: ${kept.join(", ")}`);
  // Text only: a status call must not carry child details (no row, no usage counted twice; review of #431).
  return toolResult(lines.length > 0 ? lines.join("\n") : "No subagents in this chat.", snapshot([]));
}

function stopResult(registry: SubagentRegistry, rawId: string | undefined) {
  const id = rawId?.trim() ?? "";
  if (!id) throw new Error('subagent: stop needs a child id: {action: "stop", id}.');
  if (!registry.isRunning(id)) throw new Error(`subagent: no running child with id "${id}".`);
  registry.abort(id);
  return toolResult(`Stopped subagent ${id}. Its stop notice arrives as a <subagent_report> message.`, snapshot([]));
}

async function runSingleChild(
  deps: SubagentToolDeps,
  registry: SubagentRegistry,
  status: SubagentChildStatus,
  child: Agent,
  task: string,
  stopId: string,
  signal: AbortSignal | undefined,
  scheduleEmit: () => void,
): Promise<string | undefined> {
  const startedAt = Date.now();
  // A continued child keeps its earlier messages: count only this run.
  const firstMessage = child.state.messages.length;

  status.stopId = stopId;
  const generation = registry.generation;
  status.transcript = [];
  let stoppedLocally = false;
  registry.setActiveStop(stopId, () => {
    stoppedLocally = true;
    child.abort();
  });
  // Publish the stop id at once: a child that is quiet for a while (a long
  // first model call) must still show its Stop on the row head (U3 #10).
  scheduleEmit();

  const onAbort = (): void => child.abort();
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) child.abort();

  const readPaths = new Map<string, string>();
  const sources = new Set<string>(status.sources ?? []);
  const unsub = child.subscribe((event: AgentEvent) => {
    if (event.type === "tool_execution_start" && CHILD_SOURCE_TOOLS.has(event.toolName)) {
      const path = (event.args as { path?: unknown } | undefined)?.path;
      if (typeof path === "string" && path.trim()) readPaths.set(event.toolCallId, path.trim());
    } else if (event.type === "tool_execution_end" && readPaths.has(event.toolCallId)) {
      if (!event.isError && sources.size < MAX_CHILD_SOURCES) sources.add(readPaths.get(event.toolCallId) as string);
      readPaths.delete(event.toolCallId);
      status.sources = [...sources];
    }
    // Each child model call is billed at once, so the spend cap sees it.
    if (event.type === "message_end" && event.message.role === "assistant") {
      const callUsage = sumAssistantUsage([event.message]);
      // A child of a cleared session must not charge the new one (review of #431).
      if (callUsage && registry.generation === generation) deps.recordUsage?.(callUsage, stopId);
    }
    if (!status.transcript) return;
    if (event.type === "message_update") {
      const e = event.assistantMessageEvent;
      if (e.type === "text_delta") {
        status.transcript.push({ type: "text", text: e.delta });
        scheduleEmit();
      }
    } else if (event.type === "tool_execution_start") {
      status.transcript.push({ type: "tool", name: event.toolName, status: "start", args: event.args });
      scheduleEmit();
    } else if (event.type === "tool_execution_end") {
      status.transcript.push({ type: "tool", name: event.toolName, status: "end", isError: event.isError });
      scheduleEmit();
    }
  });

  try {
    await child.prompt(task);
    await child.waitForIdle();
    // The child finished its work: drop the stop hook immediately so a Stop
    // click landing after completion can't flag this child as stopped and
    // discard an answer it actually produced.
    registry.deleteActiveStop(stopId);
  } catch (error) {
    // An abort-shaped failure is classified below from the settle flags; only a
    // genuine child error propagates to the caller's error classification.
    if (!stoppedLocally && !signal?.aborted) throw error;
  } finally {
    unsub();
    signal?.removeEventListener("abort", onAbort);
    registry.deleteActiveStop(stopId);
    status.durationMs = Date.now() - startedAt;
    const usage = sumAssistantUsage(child.state.messages.slice(firstMessage));
    if (usage) {
      status.usage = {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        totalTokens: usage.totalTokens ?? 0,
        costUsd: usage.cost?.total ?? 0,
      };
    }
  }

  const error = child.state.errorMessage;
  // Settle precedence: an explicit stop beats a clean finish — a stopped child
  // must never settle as a green-check "done". It settles as "aborted" (a
  // normal result, no re-dispatch pressure) rather than "error" (which throws
  // and invites the parent to retry the very task the user just stopped).
  if (signal?.aborted || stoppedLocally) {
    status.status = "aborted";
    status.summary = registry.takeStopReason(stopId);
  } else if (error) {
    status.status = "error";
    status.summary = redactText(truncateToolOutput(error, PER_CHILD_SUMMARY_CHARS), {
      redactHighEntropy: true,
      maxLength: 9000,
    });
  } else {
    status.status = "done";
    const report = lastAssistantText(child.state.messages.slice(firstMessage)) || "(no output)";
    status.summary = redactText(truncateToolOutput(report, PER_CHILD_SUMMARY_CHARS), {
      redactHighEntropy: true,
      maxLength: 9000,
    });
    return redactText(report, { redactHighEntropy: true, maxLength: Number.MAX_SAFE_INTEGER });
  }
  return undefined;
}

/**
 * A report longer than the inline cap is stored whole as an artifact. The
 * model gets only a pointer (owner, 2026-11-20: no partial text, so a read of
 * the artifact never repeats what it already saw); the user's subagent row
 * shows the head of the report. Null without a store or when the write fails:
 * the truncated summary then stays for both.
 */
async function keepFullReport(
  store: ToolArtifactStoreLike | undefined,
  agent: string,
  report: string,
): Promise<{ modelText: string; userPreview: string; artifactId: string } | null> {
  if (!store) return null;
  try {
    const artifact = await store.writeArtifact({
      label: `${agent} subagent report`,
      sourceToolName: SUBAGENT_TOOL_NAME,
      text: report,
      contentType: "text/markdown",
    });
    const total = report.length.toLocaleString("en-US");
    return {
      artifactId: artifact.id,
      modelText:
        // `artifact:<id>` is the reference form the artifact prune scan keeps alive.
        `Subagent "${agent}" finished. Its report is ${total} characters, too long to inline, and is stored in full as artifact:${artifact.id}. ` +
        `Read it with the artifact tool: action "read", id "${artifact.id}" (it returns chunks; continue with the offset it gives).`,
      userPreview:
        `${report.slice(0, REPORT_PREVIEW_CHARS)}\n\n[Showing the first ${REPORT_PREVIEW_CHARS.toLocaleString("en-US")} of ${total} characters. ` +
        `The full report is artifact "${artifact.id}".]`,
    };
  } catch {
    return null;
  }
}

function snapshot(statuses: SubagentChildStatus[]): SubagentDetails {
  return { kind: "subagent", children: statuses.map((status) => ({ ...status })) };
}

/**
 * The text of the last assistant message that wrote any. A final message with
 * tool calls only (or an empty one) must not hide the report written before it.
 */
export function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content
      .filter((block): block is { type: "text"; text: string } => block?.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}
