import type { AgentEvent, ChatMessage, Model, ToolCall, Usage } from "./types";
import { addUsage, emptyUsage } from "./types";
import { AgentRunError, ModelRetry, UsageLimitExceeded } from "./errors";
import { AgentTool, toToolSpec, validateToolArgs } from "./tool";

export interface AgentOptions<Deps> {
  model: Model;
  /** Static prompt, or a factory receiving the run dependencies. */
  systemPrompt: string | ((deps: Deps) => string);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: AgentTool<Deps, any>[];
  /** Maximum model request/response cycles per run. Default 12. */
  maxSteps?: number;
}

export interface AgentRunOptions<Deps> {
  deps: Deps;
  /** Prior non-system messages from earlier turns of the conversation. */
  history?: ChatMessage[];
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  output: string;
  /**
   * All non-system messages after this run (history + new messages).
   * Feed back in as `history` for multi-turn conversations.
   */
  messages: ChatMessage[];
  usage: Usage;
  steps: number;
}

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_TOOL_RETRIES = 1;

/**
 * Type-safe agent execution loop inspired by pydantic-ai.
 *
 * Each step sends the transcript to the model. If the model requests tool
 * calls they are validated, executed, and their results appended; otherwise
 * the text response ends the run. Validation failures and `ModelRetry`
 * errors are fed back to the model up to each tool's retry budget.
 */
export class Agent<Deps = unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly tools: Map<string, AgentTool<Deps, any>>;

  constructor(private readonly options: AgentOptions<Deps>) {
    this.tools = new Map();
    for (const tool of options.tools ?? []) {
      if (this.tools.has(tool.name)) {
        throw new AgentRunError(`Duplicate tool name: ${tool.name}`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  async run(prompt: string, runOptions: AgentRunOptions<Deps>): Promise<AgentRunResult> {
    const { deps, onEvent, signal } = runOptions;
    const emit = (event: AgentEvent): void => onEvent?.(event);
    const systemPrompt =
      typeof this.options.systemPrompt === "function"
        ? this.options.systemPrompt(deps)
        : this.options.systemPrompt;
    const transcript: ChatMessage[] = [
      ...(runOptions.history ?? []),
      { role: "user", content: prompt },
    ];
    const usage = emptyUsage();
    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    const toolSpecs = [...this.tools.values()].map(toToolSpec);
    const retries = new Map<string, number>();

    emit({ type: "run_start", prompt });
    try {
      for (let step = 1; step <= maxSteps; step++) {
        throwIfAborted(signal);
        emit({ type: "step_start", step });

        const response = await this.options.model.request({
          messages: [{ role: "system", content: systemPrompt }, ...transcript],
          tools: toolSpecs.length > 0 ? toolSpecs : undefined,
          signal,
          onDelta: (delta) => {
            if (delta.text) emit({ type: "text_delta", delta: delta.text });
            if (delta.reasoning) emit({ type: "reasoning_delta", delta: delta.reasoning });
          },
        });
        addUsage(usage, response.usage);
        transcript.push(response.message);

        const toolCalls = response.message.tool_calls ?? [];
        if (toolCalls.length === 0) {
          const output = response.message.content ?? "";
          emit({ type: "run_end", output, usage });
          return { output, messages: transcript, usage, steps: step };
        }

        for (const call of toolCalls) {
          throwIfAborted(signal);
          transcript.push(await this.executeToolCall(call, { deps, usage }, retries, emit));
        }
      }
      throw new UsageLimitExceeded(
        `The agent did not produce a final answer within ${maxSteps} steps. ` +
          `Increase "Max agent steps" in settings or simplify the request.`,
      );
    } catch (error) {
      emit({
        type: "run_error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async executeToolCall(
    call: ToolCall,
    base: { deps: Deps; usage: Usage },
    retries: Map<string, number>,
    emit: (event: AgentEvent) => void,
  ): Promise<ChatMessage> {
    const name = call.function.name;
    emit({ type: "tool_call_start", id: call.id, name, arguments: call.function.arguments });

    const respond = (result: string, isError: boolean): ChatMessage => {
      emit({ type: "tool_call_end", id: call.id, name, result, isError });
      return { role: "tool", content: result, tool_call_id: call.id, name };
    };

    const tool = this.tools.get(name);
    if (!tool) {
      const known = [...this.tools.keys()].join(", ") || "(none)";
      return respond(`Unknown tool: "${name}". Available tools: ${known}`, true);
    }

    const maxRetries = tool.maxRetries ?? DEFAULT_TOOL_RETRIES;
    const retryable = (message: string): ChatMessage => {
      const used = (retries.get(name) ?? 0) + 1;
      retries.set(name, used);
      if (used > maxRetries) {
        throw new AgentRunError(`Tool "${name}" failed after ${used} attempts: ${message}`);
      }
      return respond(`${message}\n\nFix the problem and try again.`, true);
    };

    const validation = validateToolArgs(tool.parameters, call.function.arguments);
    if (!validation.ok) return retryable(validation.error);

    try {
      const result = await tool.execute(validation.args, {
        ...base,
        retry: retries.get(name) ?? 0,
      });
      return respond(result, false);
    } catch (error) {
      if (error instanceof ModelRetry) return retryable(error.message);
      const message = error instanceof Error ? error.message : String(error);
      // Unexpected tool failures are surfaced to the model so it can adapt
      // (e.g. pick another note) instead of crashing the whole run.
      return respond(`Tool execution failed: ${message}`, true);
    }
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("The run was aborted.", "AbortError");
  }
}
