import { type Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentProfile } from "../agent/subagents";
import { sumAssistantUsage } from "../agent/usage";

export const SUBAGENT_TOOL_NAME = "subagent";

/** Live status of one dispatched child, streamed to the UI and returned as details. */
export interface SubagentChildStatus {
  agent: string;
  task: string;
  status: "running" | "done" | "error";
  /** Final summary text (or the error message) once the child settles. */
  summary?: string;
}

/** Structured details payload for the subagent tool result, consumed by the UI. */
export interface SubagentDetails {
  kind: "subagent";
  children: SubagentChildStatus[];
}

export interface SubagentTask {
  agent: string;
  task: string;
}

export interface SubagentToolDeps {
  /** The subagent profiles available to dispatch right now. */
  getProfiles: () => AgentProfile[];
  /** Build a ready-to-run child Agent for a profile (tools/model/stream wired by the caller). */
  createChildAgent: (profile: AgentProfile) => Agent;
  /** Report a finished child's token usage for session cost accounting. */
  recordUsage?: (usage: Usage) => void;
  /** Default cap on how many children run at once. */
  defaultConcurrency?: number;
}

const TaskSpec = Type.Object({
  agent: Type.String({ description: "Name of the subagent profile to run" }),
  task: Type.String({ description: "The focused task for this subagent" }),
});

const SubagentParameters = Type.Object({
  agent: Type.Optional(Type.String({ description: "Profile name for a single dispatch" })),
  task: Type.Optional(Type.String({ description: "Task for a single dispatch" })),
  tasks: Type.Optional(
    Type.Array(TaskSpec, { description: "Several subagents to run in parallel, each {agent, task}" }),
  ),
  concurrency: Type.Optional(
    Type.Number({ description: "Max subagents to run at once (default 3)" }),
  ),
});

/**
 * The `subagent` dispatch tool: spawns focused child agents that run in isolated
 * contexts and return summaries. Single (`{agent, task}`) or parallel (`{tasks}`).
 * Children run concurrently up to a cap; the parent abort signal cancels them all,
 * and live status streams to the UI via `onUpdate`.
 */
export function createSubagentTool(
  deps: SubagentToolDeps,
): AgentTool<typeof SubagentParameters, SubagentDetails> {
  const defaultConcurrency = deps.defaultConcurrency ?? 3;
  return {
    name: SUBAGENT_TOOL_NAME,
    label: "Dispatch subagents",
    description:
      "Delegate focused subtasks to specialist subagents, each running in its own isolated context and " +
      "returning a summary. Pass {agent, task} for one, or {tasks: [{agent, task}, ...]} to run several in " +
      "parallel. Available subagents are listed in the system prompt under \"Subagents\".",
    parameters: SubagentParameters,
    // Dispatch is a heavyweight, stateful action; keep it out of parallel batches
    // with other tools so its own fan-out controls concurrency.
    executionMode: "sequential",
    execute: async (_id, params, signal, onUpdate) => {
      const tasks = normalizeTasks(params);
      if (tasks.length === 0) {
        throw new Error('subagent: provide either {agent, task} or a non-empty {tasks: [...]}.');
      }
      const profiles = deps.getProfiles();
      for (const task of tasks) {
        if (!profiles.some((profile) => profile.name === task.agent)) {
          const available = profiles.map((profile) => profile.name).join(", ") || "(none)";
          throw new Error(`subagent: unknown agent "${task.agent}". Available: ${available}.`);
        }
      }

      const statuses: SubagentChildStatus[] = tasks.map((task) => ({
        agent: task.agent,
        task: task.task,
        status: "running",
      }));
      const emit = (): void =>
        onUpdate?.({ content: [{ type: "text", text: progressText(statuses) }], details: snapshot(statuses) });
      emit();

      const concurrency = clampConcurrency(params.concurrency ?? defaultConcurrency, tasks.length);
      await runPool(tasks.length, concurrency, signal, async (index) => {
        const status = statuses[index];
        const profile = profiles.find((candidate) => candidate.name === tasks[index].agent);
        try {
          if (!profile) throw new Error(`unknown agent "${tasks[index].agent}"`);
          const child = deps.createChildAgent(profile);
          const onAbort = (): void => child.abort();
          signal?.addEventListener("abort", onAbort);
          try {
            await child.prompt(tasks[index].task);
            await child.waitForIdle();
          } finally {
            signal?.removeEventListener("abort", onAbort);
          }
          const usage = sumAssistantUsage(child.state.messages);
          if (usage) deps.recordUsage?.(usage);
          const error = child.state.errorMessage;
          if (error) {
            status.status = "error";
            status.summary = error;
          } else {
            status.status = "done";
            status.summary = lastAssistantText(child.state.messages) || "(no output)";
          }
        } catch (error) {
          status.status = "error";
          status.summary = error instanceof Error ? error.message : String(error);
        }
        emit();
      });

      return {
        content: [{ type: "text", text: mergeSummaries(statuses) }],
        details: snapshot(statuses),
      };
    },
  };
}

/** Resolve the requested tasks from either the single or parallel call shape. */
export function normalizeTasks(params: {
  agent?: string;
  task?: string;
  tasks?: SubagentTask[];
}): SubagentTask[] {
  if (params.tasks && params.tasks.length > 0) {
    return params.tasks.map((task) => ({ agent: task.agent, task: task.task }));
  }
  if (params.agent && params.task) return [{ agent: params.agent, task: params.task }];
  return [];
}

function clampConcurrency(requested: number, count: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.floor(requested), count);
}

/**
 * Run `worker(index)` for indices 0..count-1 with at most `limit` in flight.
 * Stops pulling new work once the signal aborts (in-flight children are aborted
 * by their own listeners and settle normally).
 */
async function runPool(
  count: number,
  limit: number,
  signal: AbortSignal | undefined,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, count) }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = next++;
      if (index >= count) return;
      await worker(index);
    }
  });
  await Promise.all(runners);
}

function snapshot(statuses: SubagentChildStatus[]): SubagentDetails {
  return { kind: "subagent", children: statuses.map((status) => ({ ...status })) };
}

function progressText(statuses: SubagentChildStatus[]): string {
  const done = statuses.filter((status) => status.status !== "running").length;
  return `Running subagents (${done}/${statuses.length} done)…`;
}

function mergeSummaries(statuses: SubagentChildStatus[]): string {
  if (statuses.length === 1) {
    const only = statuses[0];
    return only.status === "error"
      ? `Subagent "${only.agent}" failed: ${only.summary ?? "unknown error"}`
      : only.summary ?? "(no output)";
  }
  return statuses
    .map((status) => {
      const heading = `### ${status.agent}: ${status.task}`;
      const body =
        status.status === "error"
          ? `(failed) ${status.summary ?? "unknown error"}`
          : status.summary ?? "(no output)";
      return `${heading}\n\n${body}`;
    })
    .join("\n\n");
}

/** Extract the text of the last assistant message in a child transcript. */
function lastAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    return message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
  }
  return "";
}
