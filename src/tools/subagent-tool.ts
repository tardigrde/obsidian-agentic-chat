import { type Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { findAgentRole, type AgentRole } from "../agent/subagents";
import { sumAssistantUsage } from "../agent/usage";
import { redactText } from "../privacy/redaction";
import { truncateToolOutput } from "../vault/truncate";
import { wrapToolOutputTruncated } from "./tool-output-wrapper";
import { toolResult, untrustedToolResult } from "./result";
import { errorMessage } from "../utils/errors";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";

export const SUBAGENT_TOOL_NAME = "subagent";

/** Default cap on how many Dispatch calls run concurrently in one parent turn (setting `maxParallelSubagents`). */
const DEFAULT_CONCURRENCY = 10;
/** Finished children kept per chat tab for `action: "continue"`; the oldest is dropped. */
export const MAX_RETAINED_CHILDREN = 10;
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
  /** Id used to abort just this child. */
  stopId?: string;
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
  private readonly pendingErrorDetails = new Map<string, SubagentDetails>();
  private readonly retained = new Map<string, RetainedChild>();
  private childCounter = 0;

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
  abort(id: string): void {
    this.activeStops.get(id)?.();
    this.activeStops.delete(id);
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

  /** Drop all state. Used when a session is cleared or replaced. */
  clear(): void {
    this.activeStops.clear();
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
}

export interface SubagentTask {
  agent: string;
  task: string;
}

const SubagentParameters = Type.Object({
  action: Type.Optional(
    Type.Union([Type.Literal("start"), Type.Literal("continue")], { description: "default start" }),
  ),
  agent: Type.Optional(Type.String({ description: "role name (start)" })),
  task: Type.String({ description: "task, or the follow-up" }),
  id: Type.Optional(Type.String({ description: "child id (continue)" })),
});

/**
 * The `subagent` dispatch tool: spawns one focused child agent in an isolated
 * context and returns its summary. Strict 1:1 — one call = one subagent; to
 * delegate several tasks, make several `subagent` calls in one message (the
 * parent loop runs them concurrently, capped by `maxParallelSubagents` in
 * flight; the rest queue). `action: "continue"` with a child id sends a
 * follow-up to a child kept from an earlier call (its context intact). The
 * parent abort signal cancels every child, and live status streams to the UI
 * via `onUpdate`.
 */
export function createSubagentTool(
  deps: SubagentToolDeps,
): AgentTool<typeof SubagentParameters, SubagentDetails> {
  // One slot pool per tool instance (and createTool() builds a fresh instance
  // per parent turn), so the cap is per-run, not global.
  const limit = Math.max(1, Math.trunc(deps.maxParallel?.() ?? DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY);
  const slots = createSlotPool(limit);
  const registry = deps.registry ?? new SubagentRegistry();
  return {
    name: SUBAGENT_TOOL_NAME,
    label: "Dispatch subagent",
    description:
      "Run one specialist subagent in an isolated context; it returns a summary and a child id. " +
      "One call = one subagent ({agent, task}). To delegate several tasks, make several " +
      `subagent calls in one message — they run in parallel (up to ${limit} at once). ` +
      'To follow up with the same child (its context intact), call {action: "continue", id, task}. ' +
      "Roles are in the system prompt; Explorer inherits parent approval/mode.",
    parameters: SubagentParameters,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const task = params.task?.trim();
      const continuing = params.action === "continue";
      let agent = params.agent?.trim();
      let retained: RetainedChild | undefined;
      let profile: AgentRole | undefined;
      if (continuing) {
        const id = params.id?.trim() ?? "";
        retained = id ? registry.retainedChild(id) : undefined;
        if (!retained) {
          throw new Error(
            `subagent: no child with id "${id}" to continue (children are kept for this chat tab, the last ${MAX_RETAINED_CHILDREN}). Start a new one with {agent, task}.`,
          );
        }
        agent = retained.agent;
        if (!task) throw new Error('subagent: continue needs a follow-up task: {action: "continue", id, task}.');
      } else {
        if (!agent || !task) {
          throw new Error("subagent: provide both {agent, task}.");
        }
        const profiles = deps.getProfiles();
        profile = findAgentRole(profiles, agent);
        if (!profile) {
          const available = profiles.map((candidate) => candidate.name).join(", ") || "(none)";
          throw new Error(`subagent: unknown agent "${agent.trim()}". Available: ${available}.`);
        }
      }
      if (!agent || !task) throw new Error("subagent: provide both {agent, task}.");

      const status: SubagentChildStatus = { agent, task, status: "queued" };
      const emit = (): void =>
        onUpdate?.(toolResult(progressText(status), snapshot([status])));

      let emitTimer: number | null = null;
      const scheduleEmit = (): void => {
        if (emitTimer) return;
        emitTimer = window.setTimeout(() => {
          emitTimer = null;
          emit();
        }, 150);
      };
      const flushEmit = (): void => {
        if (emitTimer) {
          window.clearTimeout(emitTimer);
          emitTimer = null;
        }
        emit();
      };

      try {
        // Surface the "queued" pill only while actually waiting for a slot — an
        // immediate grant (under the cap) never flashes it.
        await acquireSlot(slots, signal, () => {
          status.status = "queued";
          emit();
        });
      } catch {
        status.status = "aborted";
        status.summary = "Stopped before it started";
        flushEmit();
        return toolResult(truncateToolOutput(`Subagent "${agent}" aborted before it started.`), snapshot([status]));
      }

      status.status = "running";
      emit();
      let fullReport: string | undefined;
      const childId = retained?.id ?? registry.nextChildId();
      let child: Agent | undefined = retained?.child;
      try {
        child ??= deps.createChildAgent(profile as AgentRole);
        fullReport = await runSingleChild(deps, registry, status, child, task, toolCallId, signal, scheduleEmit);
      } catch (error) {
        if (signal?.aborted) {
          status.status = "aborted";
          status.summary = "Stopped by user";
        } else {
          status.status = "error";
          status.summary = redactText(
            truncateToolOutput(errorMessage(error), PER_CHILD_SUMMARY_CHARS),
            { redactHighEntropy: true, maxLength: 9000 },
          );
        }
      } finally {
        releaseSlot(slots);
      }
      // Keep the child for a follow-up, unless it never started.
      if (child) registry.retain({ id: childId, agent, child });
      let modelText: string | undefined;
      if (fullReport !== undefined && fullReport.length > PER_CHILD_SUMMARY_CHARS) {
        // A pending progress tick must not show "done" with the temporary
        // truncated summary while the artifact is written (review of #406).
        if (emitTimer) {
          window.clearTimeout(emitTimer);
          emitTimer = null;
        }
        const kept = await keepFullReport(deps.artifactStore, agent, fullReport);
        if (kept) {
          status.summary = kept.userPreview;
          modelText = kept.modelText;
        }
      }
      flushEmit();

      // A failed child surfaces as a failed tool call so the Dispatch step
      // renders red. A *stopped* child returns a normal result instead: the
      // parent must not feel pressure to re-dispatch a task the user just
      // stopped — the step still renders as stopped via its child statuses.
      if (status.status === "error") {
        registry.setPendingErrorDetails(toolCallId, persistedSnapshot([status]));
        throw new Error(
          wrapToolOutputTruncated(
            truncateToolOutput(`Subagent "${agent}" failed: ${status.summary ?? "unknown error"}`, PER_CHILD_SUMMARY_CHARS),
            "subagent",
          ),
        );
      }

      const followUp = `\n\n[child id: ${childId}. To follow up with this subagent, call subagent with {action: "continue", id: "${childId}", task}.]`;
      return untrustedToolResult(`${modelText ?? mergeSummaries([status])}${followUp}`, snapshot([status]), "subagent");
    },
  };
}

/**
 * Resolve the single requested task, tolerating malformed model output (blank
 * agent/task collapse to no-op). Retained for approval gating, which inspects
 * the role of the target agent before the dispatch runs.
 */
export function normalizeTasks(
  params: { agent?: string; task?: string; action?: string; id?: string },
  retainedAgent?: (id: string) => string | undefined,
): SubagentTask[] {
  // A continue call runs the role of the child it continues.
  const agent = params.action === "continue" ? (params.id ? retainedAgent?.(params.id) : undefined) : params.agent?.trim();
  const task = params.task?.trim();
  if (agent && task) return [{ agent, task }];
  return [];
}

/** Concurrency slot pool shared by all `subagent` calls of one tool instance. */
interface SlotPool {
  limit: number;
  active: number;
  waiters: Array<() => void>;
}

function createSlotPool(limit: number): SlotPool {
  return { limit, active: 0, waiters: [] };
}

/**
 * Grab a concurrency slot. When the pool is full, `onQueued` fires
 * synchronously and the returned promise resolves once a slot frees; if the
 * signal aborts first it rejects (the queued dispatch settles as aborted
 * without ever starting a child).
 */
function acquireSlot(
  pool: SlotPool,
  signal: AbortSignal | undefined,
  onQueued?: () => void,
): Promise<void> {
  if (pool.active < pool.limit) {
    pool.active += 1;
    return Promise.resolve();
  }
  onQueued?.();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const waiter = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      const index = pool.waiters.indexOf(waiter);
      if (index >= 0) pool.waiters.splice(index, 1);
      cleanup();
      reject(new Error("subagent: dispatch aborted while queued"));
    };
    pool.waiters.push(waiter);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Free a slot: promote the next queued waiter, or decrement the active count. */
function releaseSlot(pool: SlotPool): void {
  const next = pool.waiters.shift();
  if (next) next();
  else pool.active -= 1;
}

async function runSingleChild(
  deps: SubagentToolDeps,
  registry: SubagentRegistry,
  status: SubagentChildStatus,
  child: Agent,
  task: string,
  parentToolCallId: string,
  signal: AbortSignal | undefined,
  scheduleEmit: () => void,
): Promise<string | undefined> {
  const startedAt = Date.now();
  // A continued child keeps its earlier messages: count only this run.
  const firstMessage = child.state.messages.length;

  // 1:1 means the tool call id is a stable, unique stop id for this child.
  const stopId = parentToolCallId;
  status.stopId = stopId;
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

  const unsub = child.subscribe((event: AgentEvent) => {
    // Each child model call is billed at once, so the spend cap sees it.
    if (event.type === "message_end" && event.message.role === "assistant") {
      const callUsage = sumAssistantUsage([event.message]);
      if (callUsage) deps.recordUsage?.(callUsage, parentToolCallId);
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
    status.summary = "Stopped by user";
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
): Promise<{ modelText: string; userPreview: string } | null> {
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

function progressText(status: SubagentChildStatus): string {
  if (status.status === "queued") return `Queued subagent "${status.agent}"…`;
  if (status.status === "running") return `Running subagent "${status.agent}"…`;
  return `Subagent "${status.agent}" finished`;
}

function mergeSummaries(statuses: SubagentChildStatus[]): string {
  const only = statuses[0];
  return only.status === "error"
    ? `Subagent "${only.agent}" failed: ${only.summary ?? "unknown error"}`
    : only.summary ?? "(no output)";
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
