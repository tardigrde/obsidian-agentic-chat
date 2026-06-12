import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolSpec, Usage } from "./types";

/** Per-call context handed to every tool execution (pydantic-ai's RunContext). */
export interface RunContext<Deps> {
  deps: Deps;
  usage: Usage;
  /** Number of failed attempts for this tool earlier in the run. */
  retry: number;
}

export interface AgentTool<Deps = unknown, Schema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  parameters: Schema;
  /**
   * How many times the model may retry this tool after a validation error
   * or a ModelRetry before the run fails. Default 1.
   */
  maxRetries?: number;
  execute(args: z.output<Schema>, ctx: RunContext<Deps>): Promise<string> | string;
}

/**
 * Identity helper that preserves schema inference: annotate the `ctx`
 * parameter of `execute` with `RunContext<YourDeps>` and both `Deps` and
 * the argument type are inferred.
 */
export function defineTool<Deps, Schema extends z.ZodTypeAny>(tool: {
  name: string;
  description: string;
  parameters: Schema;
  maxRetries?: number;
  execute: (args: z.output<Schema>, ctx: RunContext<Deps>) => Promise<string> | string;
}): AgentTool<Deps, Schema> {
  return tool;
}

/** Convert a tool definition into the JSON-schema spec the model consumes. */
export function toToolSpec(tool: AgentTool<never, z.ZodTypeAny> | AgentTool<unknown, z.ZodTypeAny>): ToolSpec {
  const schema = zodToJsonSchema(tool.parameters, { $refStrategy: "none" }) as Record<string, unknown>;
  delete schema.$schema;
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: schema,
    },
  };
}

export type ToolArgsValidation =
  | { ok: true; args: unknown }
  | { ok: false; error: string };

/** Parse and validate the raw JSON argument string the model produced. */
export function validateToolArgs(parameters: z.ZodTypeAny, rawJson: string): ToolArgsValidation {
  let parsed: unknown;
  try {
    parsed = rawJson.trim() === "" ? {} : JSON.parse(rawJson);
  } catch (error) {
    return { ok: false, error: `Invalid JSON in tool arguments: ${(error as Error).message}` };
  }
  const result = parameters.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `Invalid arguments: ${issues}` };
  }
  return { ok: true, args: result.data };
}
