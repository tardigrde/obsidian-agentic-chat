import { requestUrl } from "obsidian";
import {
  createAssistantMessageEventStream,
  parseStreamingJson,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type Tool,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";
import { convertMessages } from "@earendil-works/pi-ai/openai-completions";
import type { WebFetcher } from "../tools/web-fetch";

export interface OpenAICompatibleRequest {
  url: string;
  method?: "POST";
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
  throw?: boolean;
}

export interface OpenAICompatibleResponse {
  status: number;
  text: string;
  json?: unknown;
  headers?: Record<string, string>;
}

export type OpenAICompatibleRequester = (
  request: OpenAICompatibleRequest,
) => Promise<OpenAICompatibleResponse>;

export function createOpenAICompatibleRequester(fetcher: WebFetcher): OpenAICompatibleRequester {
  return async (request) => {
    const headers = { ...(request.headers ?? {}) };
    if (request.contentType && !hasHeader(headers, "content-type")) {
      headers["Content-Type"] = request.contentType;
    }
    const response = await fetcher({
      url: request.url,
      method: request.method ?? "POST",
      headers,
      body: request.body,
    });
    return {
      status: response.status,
      text: response.text,
      headers: response.headers,
      json: parseJsonMaybe(response.text),
    };
  };
}

type MessageCompat = Parameters<typeof convertMessages>[2];
type ErrorReason = Extract<StopReason, "error" | "aborted">;

const MESSAGE_COMPAT: MessageCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  supportsUsageInStreaming: false,
  maxTokensField: "max_tokens",
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  requiresReasoningContentOnAssistantMessages: false,
  thinkingFormat: "openai",
  openRouterRouting: {},
  vercelGatewayRouting: {},
  zaiToolStream: false,
  supportsStrictMode: false,
  sendSessionAffinityHeaders: false,
  supportsLongCacheRetention: false,
};

/**
 * OpenAI-compatible desktop fallback over Obsidian's `requestUrl`.
 *
 * The OpenAI SDK/fetch path can run inside Obsidian's renderer, where CORS or
 * Electron proxy handling can fail even when Node/curl can reach the same URL.
 * `requestUrl` is Obsidian's own network primitive and is not subject to
 * renderer CORS, so keep this scoped to self-hosted OpenAI-compatible gateways.
 */
export function streamOpenAICompatibleViaRequestUrl(
  model: Model<"openai-completions">,
  context: Context,
  options: SimpleStreamOptions | undefined,
  requester: OpenAICompatibleRequester = requestUrl as OpenAICompatibleRequester,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output = createEmptyAssistantMessage(model);

    try {
      const apiKey = options?.apiKey?.trim();
      if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);

      let payload = buildPayload(model, context, options);
      const nextPayload = await options?.onPayload?.(payload, model);
      if (nextPayload !== undefined) payload = nextPayload as Record<string, unknown>;

      const response = await withRequestGuards(
        requester({
          url: chatCompletionsUrl(model.baseUrl),
          method: "POST",
          contentType: "application/json",
          headers: {
            ...(model.headers ?? {}),
            ...(options?.headers ?? {}),
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
          throw: false,
        }),
        options?.timeoutMs,
        options?.signal,
      );
      await options?.onResponse?.({ status: response.status, headers: normalizeHeaders(response.headers) }, model);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(formatStatusError(response));
      }

      const completion = parseCompletionResponse(response);
      output.responseId = completion.responseId;
      output.responseModel = completion.responseModel !== model.id ? completion.responseModel : undefined;
      output.usage = completion.usage;
      output.stopReason = completion.stopReason;
      output.errorMessage = completion.errorMessage;

      stream.push({ type: "start", partial: output });
      emitThinking(stream, output, completion.thinking);
      emitText(stream, output, completion.text);
      for (const toolCall of completion.toolCalls) emitToolCall(stream, output, toolCall);

      if (output.stopReason === "error") {
        throw new Error(output.errorMessage || "Provider returned an error stop reason");
      }
      if (output.stopReason === "aborted") {
        throw new Error("Request was aborted");
      }

      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end(output);
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = errorMessage(error);
      stream.push({ type: "error", reason: output.stopReason as ErrorReason, error: output });
      stream.end(output);
    }
  })();

  return stream;
}

function buildPayload(
  model: Model<"openai-completions">,
  context: Context,
  options: SimpleStreamOptions | undefined,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: model.id,
    messages: convertMessages(model, context, MESSAGE_COMPAT),
    stream: false,
  };
  const openRouterRouting = model.compat?.openRouterRouting;
  if (openRouterRouting && Object.keys(openRouterRouting).length > 0) {
    payload.provider = openRouterRouting;
  }
  if (options?.temperature !== undefined) payload.temperature = options.temperature;
  if (options?.maxTokens && options.maxTokens > 0) payload.max_tokens = options.maxTokens;
  if (context.tools && context.tools.length > 0) {
    payload.tools = convertTools(context.tools, MESSAGE_COMPAT);
    const toolChoice = (options as { toolChoice?: unknown } | undefined)?.toolChoice;
    if (toolChoice !== undefined) payload.tool_choice = toolChoice;
  } else if (hasToolHistory(context)) {
    // Some OpenAI-compatible gateways require the tools field on follow-up turns
    // that replay assistant tool_calls or tool results.
    payload.tools = [];
  }
  return payload;
}

function hasToolHistory(context: Context): boolean {
  for (const message of context.messages) {
    if (message.role === "toolResult") return true;
    if (message.role === "assistant" && message.content.some((block) => block.type === "toolCall")) return true;
  }
  return false;
}

function convertTools(tools: Tool[], compat: MessageCompat): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(compat.supportsStrictMode !== false ? { strict: false } : {}),
    },
  }));
}

interface ParsedCompletion {
  responseId?: string;
  responseModel?: string;
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
}

function parseCompletionResponse(response: OpenAICompatibleResponse): ParsedCompletion {
  const payload = responseJson(response);
  const choice = firstChoice(payload);
  const message = recordValue(choice.message);
  if (!message) throw new Error("Provider returned a choice without a message.");

  const toolCalls = parseToolCalls(message.tool_calls);
  const stop = mapStopReason(choice.finish_reason, toolCalls.length > 0);
  return {
    responseId: stringValue(payload.id),
    responseModel: stringValue(payload.model),
    text: textFromContent(message.content),
    thinking: firstString(message.reasoning_content, message.reasoning, message.reasoning_text),
    toolCalls,
    usage: parseUsage(recordValue(payload.usage) ?? recordValue(choice.usage)),
    stopReason: stop.stopReason,
    errorMessage: stop.errorMessage,
  };
}

function firstChoice(payload: Record<string, unknown>): Record<string, unknown> {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = recordValue(choices[0]);
  if (!choice) throw new Error("Provider returned no choices.");
  return choice;
}

function responseJson(response: OpenAICompatibleResponse): Record<string, unknown> {
  const parsed = recordValue(response.json);
  if (parsed) return parsed;
  try {
    const fromText: unknown = JSON.parse(response.text);
    const asRecord = recordValue(fromText);
    if (asRecord) return asRecord;
  } catch {
    // Fall through to a clearer protocol error below.
  }
  throw new Error("Provider returned a non-JSON response.");
}

function parseToolCalls(rawToolCalls: unknown): ToolCall[] {
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls.flatMap((raw, index) => {
    const toolCall = recordValue(raw);
    if (!toolCall) return [];
    const fn = recordValue(toolCall.function);
    const name = stringValue(fn?.name) || stringValue(toolCall.name) || `tool_${index + 1}`;
    const args = parseToolArguments(fn?.arguments ?? toolCall.arguments);
    return [
      {
        type: "toolCall" as const,
        id: stringValue(toolCall.id) || `call_${index + 1}`,
        name,
        arguments: args,
      },
    ];
  });
}

function parseToolArguments(rawArguments: unknown): Record<string, unknown> {
  if (recordValue(rawArguments)) return rawArguments as Record<string, unknown>;
  if (typeof rawArguments !== "string") return {};
  return parseStreamingJson<Record<string, unknown>>(rawArguments);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const block = recordValue(part);
      if (!block) return "";
      if (typeof block.text === "string") return block.text;
      return "";
    })
    .join("");
}

function parseUsage(rawUsage: Record<string, unknown> | undefined): Usage {
  const promptTokens = numberValue(rawUsage?.prompt_tokens);
  const promptDetails = recordValue(rawUsage?.prompt_tokens_details);
  const cacheReadTokens = numberValue(promptDetails?.cached_tokens) || numberValue(rawUsage?.prompt_cache_hit_tokens);
  const cacheWriteTokens = numberValue(promptDetails?.cache_write_tokens);
  const outputTokens = numberValue(rawUsage?.completion_tokens);
  const inputTokens = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  return {
    input: inputTokens,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    totalTokens: numberValue(rawUsage?.total_tokens) || inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function mapStopReason(reason: unknown, hasToolCalls: boolean): { stopReason: StopReason; errorMessage?: string } {
  if (hasToolCalls) return { stopReason: "toolUse" };
  if (reason === null || reason === undefined || reason === "stop" || reason === "end") return { stopReason: "stop" };
  if (reason === "length") return { stopReason: "length" };
  if (reason === "function_call" || reason === "tool_calls") return { stopReason: "toolUse" };
  if (reason === "content_filter") {
    return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
  }
  if (reason === "network_error") {
    return { stopReason: "error", errorMessage: "Provider finish_reason: network_error" };
  }
  return { stopReason: "error", errorMessage: `Provider finish_reason: ${String(reason)}` };
}

function createEmptyAssistantMessage(model: Model<"openai-completions">): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function emitText(stream: AssistantMessageEventStream, output: AssistantMessage, text: string): void {
  if (!text) return;
  const block = { type: "text" as const, text };
  output.content.push(block);
  const contentIndex = output.content.length - 1;
  stream.push({ type: "text_start", contentIndex, partial: output });
  stream.push({ type: "text_delta", contentIndex, delta: text, partial: output });
  stream.push({ type: "text_end", contentIndex, content: text, partial: output });
}

function emitThinking(stream: AssistantMessageEventStream, output: AssistantMessage, thinking: string): void {
  if (!thinking) return;
  const block = { type: "thinking" as const, thinking, thinkingSignature: "reasoning_content" };
  output.content.push(block);
  const contentIndex = output.content.length - 1;
  stream.push({ type: "thinking_start", contentIndex, partial: output });
  stream.push({ type: "thinking_delta", contentIndex, delta: thinking, partial: output });
  stream.push({ type: "thinking_end", contentIndex, content: thinking, partial: output });
}

function emitToolCall(stream: AssistantMessageEventStream, output: AssistantMessage, toolCall: ToolCall): void {
  output.content.push(toolCall);
  const contentIndex = output.content.length - 1;
  const delta = JSON.stringify(toolCall.arguments);
  stream.push({ type: "toolcall_start", contentIndex, partial: output });
  stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
  stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

async function withRequestGuards<T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal?.aborted) throw new RequestAbortError();
  let timer: number | undefined;
  let abortListener: (() => void) | undefined;
  const race: Array<Promise<T>> = [promise];
  if (timeoutMs && timeoutMs > 0) {
    race.push(
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new RequestTimeoutError()), timeoutMs);
      }),
    );
  }
  if (signal) {
    race.push(
      new Promise<T>((_, reject) => {
        abortListener = () => reject(new RequestAbortError());
        signal.addEventListener("abort", abortListener, { once: true });
      }),
    );
  }
  try {
    return await Promise.race(race);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

class RequestTimeoutError extends Error {
  constructor() {
    super("Request timed out.");
  }
}

class RequestAbortError extends Error {
  constructor() {
    super("Request was aborted.");
  }
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) normalized[key.toLowerCase()] = String(value);
  return normalized;
}

function formatStatusError(response: OpenAICompatibleResponse): string {
  const detail = extractErrorDetail(response);
  return `OpenAI-compatible request failed (status ${response.status})${detail ? `: ${detail}` : "."}`;
}

function extractErrorDetail(response: OpenAICompatibleResponse): string {
  const payload = recordValue(response.json);
  const error = recordValue(payload?.error);
  const detail =
    stringValue(error?.message) ||
    stringValue(payload?.detail) ||
    stringValue(payload?.message) ||
    stringValue(payload?.error);
  if (detail) return detail;
  return (response.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonMaybe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function hasHeader(headers: Record<string, string>, target: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === target.toLowerCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
