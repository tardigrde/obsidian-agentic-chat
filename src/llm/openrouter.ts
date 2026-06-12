import type {
  ChatMessage,
  Model,
  ModelRequestOptions,
  ModelResponse,
  ToolCall,
  Usage,
} from "../agent/types";
import { sseEvents } from "./sse";

/** Provider routing constraints enforced on every request. */
export interface PrivacySettings {
  /**
   * Only route to providers that do not store prompts or train on them
   * (OpenRouter `provider.data_collection = "deny"`).
   */
  denyDataCollection: boolean;
  /**
   * Only route to endpoints with a Zero Data Retention policy
   * (OpenRouter `provider.zdr = true`). Strictest option.
   */
  requireZDR: boolean;
  /**
   * Allow OpenRouter to fall back to other, still policy-compliant,
   * providers when the preferred one is unavailable.
   */
  allowFallbacks: boolean;
}

export interface OpenRouterModelConfig {
  apiKey: string;
  model: string;
  privacy: PrivacySettings;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  /** Time budget for receiving response headers. Default 90s. */
  requestTimeoutMs?: number;
  /** Automatic retries for rate limits and transient server errors. Default 2. */
  maxRetries?: number;
  referer?: string;
  title?: string;
  /** Injection point for tests. */
  fetchImpl?: typeof fetch;
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  supportsTools: boolean;
}

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_NETWORK_RETRIES = 2;
const DEFAULT_REFERER = "https://github.com/tardigrde/obsidian-agentic-chat";
const DEFAULT_TITLE = "Obsidian Agentic Chat";

const FRIENDLY_STATUS_MESSAGES: Record<number, string> = {
  400: "OpenRouter rejected the request as invalid.",
  401: "Invalid OpenRouter API key. Check the plugin settings.",
  402: "Insufficient OpenRouter credits.",
  403: "Request blocked by OpenRouter moderation or provider policy.",
  404: "Model or endpoint not found. With privacy enforcement on, no compliant provider may exist for this model.",
  408: "OpenRouter request timed out.",
  429: "OpenRouter rate limit hit.",
};

/** Streaming chat-completions client for OpenRouter implementing the agent's Model interface. */
export class OpenRouterModel implements Model {
  private readonly fetch: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly config: OpenRouterModelConfig) {
    this.fetch = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  get id(): string {
    return this.config.model;
  }

  async request(options: ModelRequestOptions): Promise<ModelResponse> {
    const body = this.buildBody(options);
    const response = await this.fetchWithRetry(body, options.signal);
    return this.readStream(response, options);
  }

  private buildBody(options: ModelRequestOptions): Record<string, unknown> {
    const { privacy } = this.config;
    const provider: Record<string, unknown> = {};
    if (privacy.denyDataCollection) provider.data_collection = "deny";
    if (privacy.requireZDR) provider.zdr = true;
    if (!privacy.allowFallbacks) provider.allow_fallbacks = false;

    return {
      model: this.config.model,
      // Reasoning text is local-only metadata; never send it back upstream.
      messages: options.messages.map(({ reasoning: _reasoning, ...message }) => message),
      stream: true,
      usage: { include: true },
      ...(options.tools ? { tools: options.tools } : {}),
      ...(this.config.temperature !== undefined ? { temperature: this.config.temperature } : {}),
      ...(this.config.maxTokens ? { max_tokens: this.config.maxTokens } : {}),
      ...(Object.keys(provider).length > 0 ? { provider } : {}),
    };
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": this.config.referer ?? DEFAULT_REFERER,
      "X-Title": this.config.title ?? DEFAULT_TITLE,
    };
  }

  private async fetchWithRetry(body: unknown, callerSignal?: AbortSignal): Promise<Response> {
    const maxRetries = this.config.maxRetries ?? DEFAULT_NETWORK_RETRIES;
    let lastError = new OpenRouterError("OpenRouter request failed.");
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await delay(backoffMs(attempt), callerSignal);
      let response: Response;
      try {
        response = await this.fetchOnce(body, callerSignal);
      } catch (error) {
        if (callerSignal?.aborted) throw error;
        if (error instanceof OpenRouterError && error.retryable) {
          lastError = error;
          continue;
        }
        throw error;
      }
      if (response.ok) return response;
      const error = await this.toError(response);
      if (!error.retryable) throw error;
      lastError = error;
    }
    throw lastError;
  }

  private async fetchOnce(body: unknown, callerSignal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      return await this.fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (callerSignal?.aborted) throw error;
      if (controller.signal.aborted) {
        throw new OpenRouterError("OpenRouter request timed out.", 408, true);
      }
      throw new OpenRouterError(
        `Network error talking to OpenRouter: ${(error as Error).message}`,
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private async toError(response: Response): Promise<OpenRouterError> {
    let detail = "";
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      detail = payload?.error?.message ?? "";
    } catch {
      // Body unavailable or not JSON; the status-based message is enough.
    }
    const status = response.status;
    const message =
      FRIENDLY_STATUS_MESSAGES[status] ?? `OpenRouter request failed with status ${status}.`;
    const retryable = status === 408 || status === 429 || status >= 500;
    return new OpenRouterError(detail ? `${message} (${detail})` : message, status, retryable);
  }

  private async readStream(
    response: Response,
    options: ModelRequestOptions,
  ): Promise<ModelResponse> {
    if (!response.body) {
      throw new OpenRouterError("OpenRouter returned an empty response body.");
    }
    let content = "";
    let reasoning = "";
    let finishReason: string | null = null;
    const toolCalls = new Map<number, ToolCall>();
    const usage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 1 };

    for await (const payload of sseEvents(response.body)) {
      if (payload === "[DONE]") break;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(payload) as StreamChunk;
      } catch {
        continue; // Tolerate malformed keep-alive payloads.
      }
      if (chunk.error) {
        throw new OpenRouterError(
          chunk.error.message ?? "OpenRouter reported a mid-stream error.",
          typeof chunk.error.code === "number" ? chunk.error.code : undefined,
        );
      }
      if (chunk.usage) {
        usage.promptTokens = chunk.usage.prompt_tokens ?? 0;
        usage.completionTokens = chunk.usage.completion_tokens ?? 0;
        usage.totalTokens = chunk.usage.total_tokens ?? 0;
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        options.onDelta?.({ text: delta.content });
      }
      if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
        reasoning += delta.reasoning;
        options.onDelta?.({ reasoning: delta.reasoning });
      }
      for (const fragment of delta.tool_calls ?? []) {
        const index = fragment.index ?? 0;
        const existing = toolCalls.get(index) ?? {
          id: "",
          type: "function" as const,
          function: { name: "", arguments: "" },
        };
        if (fragment.id) existing.id = fragment.id;
        if (fragment.function?.name) existing.function.name += fragment.function.name;
        if (fragment.function?.arguments) existing.function.arguments += fragment.function.arguments;
        toolCalls.set(index, existing);
      }
    }

    const calls = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call], i) => ({ ...call, id: call.id || `call_${i}` }));
    const message: ChatMessage = {
      role: "assistant",
      content: content.length > 0 ? content : calls.length > 0 ? null : "",
      ...(reasoning ? { reasoning } : {}),
      ...(calls.length > 0 ? { tool_calls: calls } : {}),
    };
    return { message, usage, finishReason };
  }
}

interface StreamChunk {
  error?: { message?: string; code?: unknown };
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
}

/** Fetch the OpenRouter model catalog (used by the settings model browser). */
export async function listModels(
  apiKey: string,
  options?: { baseUrl?: string; fetchImpl?: typeof fetch },
): Promise<OpenRouterModelInfo[]> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const baseUrl = (options?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new OpenRouterError(`Failed to list models (status ${response.status}).`, response.status);
  }
  const payload = (await response.json()) as {
    data?: Array<{
      id: string;
      name?: string;
      context_length?: number;
      supported_parameters?: string[];
    }>;
  };
  return (payload.data ?? []).map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    contextLength: model.context_length ?? null,
    supportsTools: (model.supported_parameters ?? []).includes("tools"),
  }));
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException("The run was aborted.", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}
