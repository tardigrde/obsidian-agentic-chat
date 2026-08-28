import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
} from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import {
  createOpenAICompatibleRequester,
  streamOpenAICompatibleViaRequestUrl,
} from "../llm/openai-compatible-request";
import { sharedAgentModels } from "../llm/providers";
import { createProxiedFetcher } from "../mcp/fetcher";
import { backoffDelayMs, classifyError, sleep } from "./error-classifier";

const HTTP_REFERER = "https://github.com/tardigrde/obsidian-agentic-chat";
const X_TITLE = "Obsidian Agentic Chat";

export type StreamSimpleFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;
type OpenAICompatibleStreamFn = typeof streamOpenAICompatibleViaRequestUrl;

export interface AgentStreamRuntimeOptions {
  getSettings: () => AgenticChatSettings;
  streamFn?: StreamFn;
  streamSimpleFn?: StreamSimpleFn;
  openAICompatibleStreamFn?: OpenAICompatibleStreamFn;
}

/**
 * Builds the model stream function used by parent and child agents. This owns
 * request option shaping and the desktop OpenAI-compatible fallback; callers own
 * when to create or refresh the pi Agent.
 */
export class AgentStreamRuntime {
  private readonly getSettings: () => AgenticChatSettings;
  private readonly injectedStreamFn?: StreamFn;
  private readonly streamSimpleFn: StreamSimpleFn;
  private readonly openAICompatibleStreamFn: OpenAICompatibleStreamFn;

  constructor(options: AgentStreamRuntimeOptions) {
    this.getSettings = options.getSettings;
    this.injectedStreamFn = options.streamFn;
    this.streamSimpleFn =
      options.streamSimpleFn ?? ((model, context, streamOptions) => sharedAgentModels().streamSimple(model, context, streamOptions));
    this.openAICompatibleStreamFn = options.openAICompatibleStreamFn ?? streamOpenAICompatibleViaRequestUrl;
  }

  buildStreamFn(): StreamFn {
    if (this.injectedStreamFn) return this.injectedStreamFn;
    return (model, context, options) => {
      const settings = this.getSettings();
      const streamOptions = {
        ...options,
        temperature: settings.temperature,
        ...(settings.maxTokens > 0 ? { maxTokens: settings.maxTokens } : {}),
        timeoutMs: settings.requestTimeoutMs,
        maxRetries: settings.maxNetworkRetries,
        headers: { "HTTP-Referer": HTTP_REFERER, "X-Title": X_TITLE, ...(options?.headers) },
      };
      const proxiedRequester = settings.network.proxyUrl
        ? createOpenAICompatibleRequester(createProxiedFetcher(settings.network))
        : undefined;
      if (model.provider === "openai-compatible" && model.api === "openai-completions") {
        return this.openAICompatibleStreamFn(
          model as Model<"openai-completions">,
          context,
          streamOptions,
          proxiedRequester,
        );
      }
      if (model.provider === "openrouter" && model.api === "openai-completions" && proxiedRequester) {
        return this.openAICompatibleStreamFn(
          model as Model<"openai-completions">,
          context,
          streamOptions,
          proxiedRequester,
        );
      }
      return this.wrapStreamSimpleWithRetry(model, context, streamOptions, options?.signal);
    };
  }

  private wrapStreamSimpleWithRetry(
    model: Model<Api>,
    context: Context,
    streamOptions: SimpleStreamOptions,
    signal?: AbortSignal,
  ): AssistantMessageEventStream {
    const maxRetries = Math.max(0, Math.floor(streamOptions.maxRetries ?? 0));
    if (maxRetries === 0) return this.streamSimpleFn(model, context, streamOptions);
    const outer = createAssistantMessageEventStream();
    void (async () => {
      let attempt = 0;
      while (true) {
        const buffered: unknown[] = [];
        let hadContent = false;
        let errorMessage: string | undefined;
        try {
          const innerOptions: SimpleStreamOptions = { ...streamOptions, maxRetries: 0, signal };
          const inner = this.streamSimpleFn(model, context, innerOptions);
          for await (const event of inner) {
            buffered.push(event);
            const type = (event as { type?: string }).type;
            if (type === "text_start" || type === "text_delta" || type === "thinking_start" || type === "thinking_delta" || type === "toolcall_start" || type === "toolcall_delta") {
              hadContent = true;
            }
            if (type === "error") {
              const err = (event as { error?: { errorMessage?: string }; reason?: string }).error?.errorMessage ?? (event as { error?: string }).error ?? "stream error";
              errorMessage = typeof err === "string" ? err : String(err);
            }
          }
          const result = await inner.result();
          if (result.stopReason === "error" && result.errorMessage) errorMessage = result.errorMessage;
          if (result.stopReason === "aborted") errorMessage = result.errorMessage ?? "aborted";
          if (errorMessage) {
            const classified = classifyError(errorMessage);
            const shouldRetry = !hadContent && classified.retryable && attempt < maxRetries && !signal?.aborted && classified.class !== "resource" && classified.class !== "aborted" && classified.class !== "model" && classified.class !== "permanent";
            if (!shouldRetry) {
              for (const event of buffered) outer.push(event as never);
              outer.end(result);
              break;
            }
            const delay = backoffDelayMs(attempt, classified.retryAfterMs);
            console.warn(`Agentic Chat: model stream ${classified.class} (attempt ${attempt + 1}/${maxRetries}) retrying in ${delay}ms: ${classified.message.slice(0, 200)}`);
            await sleep(delay, signal);
            attempt += 1;
            continue;
          }
          for (const event of buffered) outer.push(event as never);
          outer.end(result);
          break;
        } catch (error) {
          const classified = classifyError(error);
          errorMessage = classified.message;
          const shouldRetry = !hadContent && classified.retryable && attempt < maxRetries && !signal?.aborted;
          if (!shouldRetry) {
            const reason: StopReason = signal?.aborted || classified.class === "aborted" ? "aborted" : "error";
            const dummy: import("@earendil-works/pi-ai").AssistantMessage = {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: reason,
              errorMessage,
              timestamp: Date.now(),
            };
            outer.push({ type: "error", reason: reason as never, error: dummy } as never);
            outer.end(dummy);
            break;
          }
          const delay = backoffDelayMs(attempt, classified.retryAfterMs);
          console.warn(`Agentic Chat: model stream ${classified.class} (attempt ${attempt + 1}/${maxRetries}) retrying in ${delay}ms: ${classified.message.slice(0, 200)}`);
          try {
            await sleep(delay, signal);
          } catch {
            const dummy: import("@earendil-works/pi-ai").AssistantMessage = {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: "aborted",
              errorMessage: "aborted",
              timestamp: Date.now(),
            };
            outer.push({ type: "error", reason: "aborted" as never, error: dummy } as never);
            outer.end(dummy);
            break;
          }
          attempt += 1;
        }
      }
    })();
    return outer;
  }
}
