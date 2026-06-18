import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

/** Tools that touch the durable memory store (M1). `remember` mutates; `recall` is read-only. */
export const MEMORY_TOOLS = new Set(["remember", "recall"]);

/** Read/append access to the durable memory, backed by the AgentService. */
export interface MemoryAccess {
  /** The current durable memory text. */
  read(): string;
  /** Append a fact and persist it; returns the updated memory text. */
  append(fact: string): Promise<string>;
}

const RememberParameters = Type.Object({
  fact: Type.String({ description: "A concise durable fact or instruction to save to memory" }),
});

const RecallParameters = Type.Object({});

/**
 * The durable-memory tools. `remember` saves a fact (mutating — it flows through
 * the approval gate like write/edit); `recall` returns the full memory
 * (read-only). Registered alongside the vault tools in the parent tool set.
 */
export function createMemoryTools(access: MemoryAccess): AgentTool[] {
  return [createRememberTool(access), createRecallTool(access)];
}

function createRememberTool(access: MemoryAccess): AgentTool<typeof RememberParameters> {
  return {
    name: "remember",
    label: "Remember",
    description: "Save a concise fact or instruction to durable memory. It persists across conversations.",
    parameters: RememberParameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const fact = (params.fact ?? "").trim();
      if (!fact) throw new Error("Nothing to remember: pass a non-empty fact.");
      const updated = await access.append(fact);
      return memoryResult(`Saved to memory:\n\n${updated}`, { fact });
    },
  };
}

function createRecallTool(access: MemoryAccess): AgentTool<typeof RecallParameters> {
  return {
    name: "recall",
    label: "Recall memory",
    description: "Read the full durable memory: every fact and instruction saved so far.",
    parameters: RecallParameters,
    execute: async () => {
      const memory = access.read().trim();
      const text = memory || "(memory is empty)";
      return memoryResult(text, { empty: memory.length === 0 });
    },
  };
}

function memoryResult(text: string, details: Record<string, unknown>): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details };
}
