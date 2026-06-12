import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { ToolSpec, Usage } from "./types";

/** Per-call context handed to every tool execution (pydantic-ai's RunContext). */
export interface RunContext<Deps> {
  deps: Deps;
  usage: Usage;
  /** Number of failed attempts for this tool earlier in the run. */
  retry: number;
}

export interface AgentTool<Deps = unknown, Schema extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: Schema;
  /**
   * How many times the model may retry this tool after a validation error
   * or a ModelRetry before the run fails. Default 1.
   */
  maxRetries?: number;
  execute(args: Static<Schema>, ctx: RunContext<Deps>): Promise<string> | string;
}

/**
 * Identity helper that preserves schema inference: annotate the `ctx`
 * parameter of `execute` with `RunContext<YourDeps>` and both `Deps` and
 * the argument type are inferred.
 */
export function defineTool<Deps, Schema extends TSchema>(tool: {
  name: string;
  description: string;
  parameters: Schema;
  maxRetries?: number;
  execute: (args: Static<Schema>, ctx: RunContext<Deps>) => Promise<string> | string;
}): AgentTool<Deps, Schema> {
  return tool;
}

/**
 * String enum emitted as a JSON-schema `enum` keyword. TypeBox unions of
 * literals serialize to `anyOf`, which models follow less reliably.
 */
export function stringEnum<const T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}

/** Convert a tool definition into the JSON-schema spec the model consumes. */
export function toToolSpec(tool: AgentTool<never, TSchema> | AgentTool<unknown, TSchema>): ToolSpec {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      // TypeBox schemas are plain JSON Schema; internal metadata lives on
      // non-enumerable keys, which JSON.stringify drops when the request
      // body is serialized.
      parameters: tool.parameters as unknown as Record<string, unknown>,
    },
  };
}

export type ToolArgsValidation =
  | { ok: true; args: unknown }
  | { ok: false; error: string };

/** Parse and validate the raw JSON argument string the model produced. */
export function validateToolArgs(parameters: TSchema, rawJson: string): ToolArgsValidation {
  let parsed: unknown;
  try {
    parsed = rawJson.trim() === "" ? {} : JSON.parse(rawJson);
  } catch (error) {
    return { ok: false, error: `Invalid JSON in tool arguments: ${(error as Error).message}` };
  }
  // Mirror zod's parse semantics: fill declared defaults, strip unknown keys.
  const value = Value.Clean(parameters, Value.Default(parameters, Value.Clone(parsed)));
  if (!Value.Check(parameters, value)) {
    const issues = [...Value.Errors(parameters, value)]
      .map((issue) => `${issue.instancePath.slice(1).replaceAll("/", ".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: `Invalid arguments: ${issues}` };
  }
  return { ok: true, args: value };
}
