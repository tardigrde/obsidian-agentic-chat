/**
 * Message, usage and event types shared across the agent runtime.
 *
 * The wire format mirrors the OpenAI/OpenRouter chat completions schema so
 * messages can be stored and replayed without translation.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: Role;
  content: string | null;
  /** Present on assistant messages that request tool execution. */
  tool_calls?: ToolCall[];
  /** Present on tool result messages; links the result to its request. */
  tool_call_id?: string;
  name?: string;
  /** Model reasoning text when the provider exposes it. Never sent back to the API. */
  reasoning?: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requests: number;
}

export function emptyUsage(): Usage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
}

export function addUsage(into: Usage, from: Partial<Usage>): void {
  into.promptTokens += from.promptTokens ?? 0;
  into.completionTokens += from.completionTokens ?? 0;
  into.totalTokens += from.totalTokens ?? 0;
  into.requests += from.requests ?? 0;
}

/** JSON-schema based tool declaration sent to the model. */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamDelta {
  text?: string;
  reasoning?: string;
}

export interface ModelResponse {
  message: ChatMessage;
  usage: Usage;
  finishReason: string | null;
}

export interface ModelRequestOptions {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  onDelta?: (delta: StreamDelta) => void;
}

/**
 * Minimal model interface the agent loop depends on.
 * Keeps the loop fully testable without network access.
 */
export interface Model {
  readonly id: string;
  request(options: ModelRequestOptions): Promise<ModelResponse>;
}

/** Events emitted during an agent run, used to drive the chat UI timeline. */
export type AgentEvent =
  | { type: "run_start"; prompt: string }
  | { type: "step_start"; step: number }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call_start"; id: string; name: string; arguments: string }
  | { type: "tool_call_end"; id: string; name: string; result: string; isError: boolean }
  | { type: "run_end"; output: string; usage: Usage }
  | { type: "run_error"; message: string };
