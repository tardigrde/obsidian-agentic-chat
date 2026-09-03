import { type Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { findAgentRole, type AgentRole } from "../agent/subagents";
import { sumAssistantUsage } from "../agent/usage";
import { redactText } from "../privacy/redaction";
import { truncateToolOutput } from "../vault/truncate";
import { wrapToolOutputTruncated } from "./tool-output-wrapper";

export const SUBAGENT_TOOL_NAME = "subagent";

/** Hard cap on how many Dispatch calls run concurrently in one parent turn. */
const MAX_CONCURRENCY = 10;
/** Per-child summary cap (characters) fed into the parent's context. */
const PER_CHILD_SUMMARY_CHARS = 8_000;

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

const activeStops = new Map<string, () => void>();
export function abortSubagentChild(id: string): void {
  activeStops.get(id)?.();
  activeStops.delete(id);
}

/** Structured details payload for the subagent tool result, consumed by the UI. */
export interface SubagentDetails {
  kind: "subagent";
  children: SubagentChildStatus[];
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

/** Pending error details for a toolCallId that threw — injected via `afterToolCall` so the error toolResult still carries the dispatch card. */
export const pendingSubagentErrorDetails = new Map<string, SubagentDetails>();

export function clearPendingSubagentErrorDetails(id?: string): void {
  if (id) pendingSubagentErrorDetails.delete(id);
  else pendingSubagentErrorDetails.clear();
}

export interface SubagentTask {
  agent: string;
  task: string;
}

export interface SubagentToolDeps {
  /** The subagent roles available to dispatch right now (formerly profiles). */
  getProfiles: () => AgentRole[];
  /** Build a ready-to-run child Agent for a role (tools/model/stream wired by the caller). */
  createChildAgent: (profile: AgentRole) => Agent;
  /** Report a finished child's token usage for session cost accounting. */
  recordUsage?: (usage: Usage) => void;
  /** Auto-abort a child that runs longer than this many seconds. 0 disables. */
  maxRuntimeSeconds?: () => number;
}

const SubagentParameters = Type.Object({
  agent: Type.String({ description: "role name" }),
  task: Type.String({ description: "task to delegate" }),
});

/**
 * The `subagent` dispatch tool: spawns one focused child agent in an isolated
 * context and returns its summary. Strict 1:1 — one call = one subagent; to
 * delegate several tasks, make several `subagent` calls in one message (the
 * parent loop runs them concurrently, capped at {@link MAX_CONCURRENCY} in
 * flight; the rest queue). The parent abort signal cancels every child, and
 * live status streams to the UI via `onUpdate`.
 */
export function createSubagentTool(
  deps: SubagentToolDeps,
): AgentTool<typeof SubagentParameters, SubagentDetails> {
  // One slot pool per tool instance (and createTool() builds a fresh instance
  // per parent turn), so the cap is per-run, not global.
  const slots = createSlotPool(MAX_CONCURRENCY);
  return {
    name: SUBAGENT_TOOL_NAME,
    label: "Dispatch subagent",
    description:
      "Run one specialist subagent in an isolated context; it returns a summary. " +
      "One call = one subagent ({agent, task}). To delegate several tasks, make several " +
      "subagent calls in one message — they run in parallel (up to 10 at once). " +
      "Roles are in the system prompt (formerly profiles); Explorer inherits parent approval/mode.",
    parameters: SubagentParameters,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const agent = params.agent?.trim();
      const task = params.task?.trim();
      if (!agent || !task) {
        throw new Error("subagent: provide both {agent, task}.");
      }
      const profiles = deps.getProfiles();
      const profile = findAgentRole(profiles, agent);
      if (!profile) {
        const available = profiles.map((candidate) => candidate.name).join(", ") || "(none)";
        throw new Error(`subagent: unknown agent "${agent.trim()}". Available: ${available}.`);
      }

      const status: SubagentChildStatus = { agent, task, status: "queued" };
      const emit = (): void =>
        onUpdate?.({ content: [{ type: "text", text: progressText(status) }], details: snapshot([status]) });

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
        return {
          content: [{ type: "text", text: truncateToolOutput(`Subagent "${agent}" aborted before it started.`) }],
          details: snapshot([status]),
        };
      }

      status.status = "running";
      emit();
      try {
        await runSingleChild(deps, status, profile, task, toolCallId, signal, scheduleEmit);
      } catch (error) {
        if (signal?.aborted) {
          status.status = "aborted";
          status.summary = "Stopped by user";
        } else {
          status.status = "error";
          status.summary = redactText(
            truncateToolOutput(error instanceof Error ? error.message : String(error), PER_CHILD_SUMMARY_CHARS),
            { redactHighEntropy: true, maxLength: 9000 },
          );
        }
      } finally {
        releaseSlot(slots);
      }
      flushEmit();

      // A failed child surfaces as a failed tool call so the Dispatch step
      // renders red. A *stopped* child returns a normal result instead: the
      // parent must not feel pressure to re-dispatch a task the user just
      // stopped — the step still renders as stopped via its child statuses.
      if (status.status === "error") {
        pendingSubagentErrorDetails.set(toolCallId, persistedSnapshot([status]));
        throw new Error(
          wrapToolOutputTruncated(
            truncateToolOutput(`Subagent "${agent}" failed: ${status.summary ?? "unknown error"}`, PER_CHILD_SUMMARY_CHARS),
            "subagent",
          ),
        );
      }

      return {
        content: [{ type: "text", text: wrapToolOutputTruncated(truncateToolOutput(mergeSummaries([status])), "subagent") }],
        details: snapshot([status]),
      };
    },
  };
}

/**
 * Resolve the single requested task, tolerating malformed model output (blank
 * agent/task collapse to no-op). Retained for approval gating, which inspects
 * the role of the target agent before the dispatch runs.
 */
export function normalizeTasks(params: { agent?: string; task?: string }): SubagentTask[] {
  const agent = params.agent?.trim();
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
  status: SubagentChildStatus,
  profile: AgentRole,
  task: string,
  parentToolCallId: string,
  signal: AbortSignal | undefined,
  scheduleEmit: () => void,
): Promise<void> {
  const child = deps.createChildAgent(profile);
  const startedAt = Date.now();

  // 1:1 means the tool call id is a stable, unique stop id for this child.
  const stopId = parentToolCallId;
  status.stopId = stopId;
  status.transcript = [];
  let stoppedLocally = false;
  activeStops.set(stopId, () => {
    stoppedLocally = true;
    child.abort();
  });

  const onAbort = (): void => child.abort();
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) child.abort();

  const maxSeconds = deps.maxRuntimeSeconds?.() ?? 0;
  let timedOut = false;
  const timeoutTimer =
    maxSeconds > 0
      ? window.setTimeout(() => {
          timedOut = true;
          child.abort();
        }, maxSeconds * 1000)
      : null;

  const unsub = child.subscribe((event: AgentEvent) => {
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
    activeStops.delete(stopId);
  } catch (error) {
    // An abort-shaped failure is classified below from the settle flags; only a
    // genuine child error propagates to the caller's error classification.
    if (!timedOut && !stoppedLocally && !signal?.aborted) throw error;
  } finally {
    if (timeoutTimer) window.clearTimeout(timeoutTimer);
    unsub();
    signal?.removeEventListener("abort", onAbort);
    activeStops.delete(stopId);
    status.durationMs = Date.now() - startedAt;
    const usage = sumAssistantUsage(child.state.messages);
    if (usage) {
      deps.recordUsage?.(usage);
      status.usage = {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        totalTokens: usage.totalTokens ?? 0,
        costUsd: usage.cost?.total ?? 0,
      };
    }
  }

  const error = child.state.errorMessage;
  // Settle precedence: an explicit stop wins over a timeout firing at the same
  // moment, and both beat a clean finish — a stopped/timed-out child must never
  // settle as a green-check "done". Both settle as "aborted" (a normal result,
  // no re-dispatch pressure) rather than "error" (which throws and invites the
  // parent to retry the very task the user just stopped or capped).
  if (signal?.aborted || stoppedLocally) {
    status.status = "aborted";
    status.summary = "Stopped by user";
  } else if (timedOut) {
    status.status = "aborted";
    status.summary = `Timed out after ${maxSeconds}s`;
  } else if (error) {
    status.status = "error";
    status.summary = redactText(truncateToolOutput(error, PER_CHILD_SUMMARY_CHARS), {
      redactHighEntropy: true,
      maxLength: 9000,
    });
  } else {
    status.status = "done";
    status.summary = redactText(
      truncateToolOutput(lastAssistantText(child.state.messages) || "(no output)", PER_CHILD_SUMMARY_CHARS),
      { redactHighEntropy: true, maxLength: 9000 },
    );
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

/** Extract the text of the last assistant message in a child transcript. */
function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    return content
      .filter((block): block is { type: "text"; text: string } => block?.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
  }
  return "";
}
