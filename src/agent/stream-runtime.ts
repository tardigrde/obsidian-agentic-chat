import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
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
import { backoffDelayMs, classifyError, sleep, type ClassifiedError } from "./error-classifier";

const HTTP_REFERER = "https://github.com/tardigrde/obsidian-agentic-chat";
const X_TITLE = "Obsidian Agentic Chat";

const CONTENT_EVENT_TYPES = new Set([
  "text_start",
  "text_delta",
  "text_end",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
]);

interface StreamAttemptResult {
  kind: "result";
  buffered: unknown[];
  hadContent: boolean;
  result: AssistantMessage;
  errorMessage?: string;
}

interface StreamAttemptFailure {
  kind: "threw";
  buffered: unknown[];
  hadContent: boolean;
  classified: ClassifiedError;
  errorMessage: string;
}

type StreamAttemptOutcome = StreamAttemptResult | StreamAttemptFailure;

interface RetryPlan {
  classified: ClassifiedError;
  delay: number;
}

function eventType(event: unknown): string | undefined {
  return (event as { type?: string }).type;
}

function isContentEvent(event: unknown): boolean {
  const type = eventType(event);
  return type !== undefined && CONTENT_EVENT_TYPES.has(type);
}

function eventErrorMessage(event: unknown): string | undefined {
  if (eventType(event) !== "error") return undefined;
  const err =
    (event as { error?: { errorMessage?: string } }).error?.errorMessage ??
    (event as { error?: string }).error ??
    "stream error";
  return typeof err === "string" ? err : String(err);
}

function resultErrorMessage(result: AssistantMessage, previous: string | undefined): string | undefined {
  if (result.stopReason === "error" && result.errorMessage) return result.errorMessage;
  if (result.stopReason === "aborted") return result.errorMessage ?? "aborted";
  return previous;
}

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
    void this.runStreamWithRetries(model, context, streamOptions, signal, maxRetries, outer);
    return outer;
  }

  private async runStreamWithRetries(
    model: Model<Api>,
    context: Context,
    streamOptions: SimpleStreamOptions,
    signal: AbortSignal | undefined,
    maxRetries: number,
    outer: AssistantMessageEventStream,
  ): Promise<void> {
    let attempt = 0;
    for (;;) {
      const outcome = await this.attemptStream(model, context, streamOptions, signal);
      const plan = this.planRetry(outcome, attempt, maxRetries, streamOptions, signal);
      if (!plan) {
        this.finishAttempt(outer, outcome, model, signal);
        return;
      }
      if (!(await this.delayBeforeRetry(outcome, plan, attempt, maxRetries, outer, model, signal))) return;
      attempt += 1;
    }
  }

  private async attemptStream(
    model: Model<Api>,
    context: Context,
    streamOptions: SimpleStreamOptions,
    signal?: AbortSignal,
  ): Promise<StreamAttemptOutcome> {
    const buffered: unknown[] = [];
    let hadContent = false;
    let errorMessage: string | undefined;
    try {
      const innerOptions: SimpleStreamOptions = { ...streamOptions, maxRetries: 0, signal };
      const inner = this.streamSimpleFn(model, context, innerOptions);
      for await (const event of inner) {
        buffered.push(event);
        if (isContentEvent(event)) hadContent = true;
        const eventError = eventErrorMessage(event);
        if (eventError !== undefined) errorMessage = eventError;
      }
      const result = await inner.result();
      return { kind: "result", buffered, hadContent, result, errorMessage: resultErrorMessage(result, errorMessage) };
    } catch (error) {
      const classified = classifyError(error);
      return { kind: "threw", buffered, hadContent, classified, errorMessage: classified.message };
    }
  }

  private classifyOutcome(outcome: StreamAttemptOutcome): ClassifiedError | undefined {
    if (outcome.kind === "threw") return outcome.classified;
    return outcome.errorMessage ? classifyError(outcome.errorMessage) : undefined;
  }

  private planRetry(
    outcome: StreamAttemptOutcome,
    attempt: number,
    maxRetries: number,
    streamOptions: SimpleStreamOptions,
    signal?: AbortSignal,
  ): RetryPlan | undefined {
    const classified = this.classifyOutcome(outcome);
    if (!classified) return undefined;
    if (!this.shouldRetryStream(classified, outcome.hadContent, attempt, maxRetries, signal)) return undefined;
    const delay = backoffDelayMs(attempt, classified.retryAfterMs);
    if (this.exceedsMaxDelay(delay, streamOptions.maxRetryDelayMs)) return undefined;
    return { classified, delay };
  }

  private finishAttempt(
    outer: AssistantMessageEventStream,
    outcome: StreamAttemptOutcome,
    model: Model<Api>,
    signal?: AbortSignal,
  ): void {
    for (const event of outcome.buffered) outer.push(event as never);
    if (outcome.kind === "result") {
      outer.end(outcome.result);
      return;
    }
    const reason = signal?.aborted || outcome.classified.class === "aborted" ? "aborted" : "error";
    this.pushStreamError(outer, model, reason, outcome.errorMessage);
  }

  private async delayBeforeRetry(
    outcome: StreamAttemptOutcome,
    plan: RetryPlan,
    attempt: number,
    maxRetries: number,
    outer: AssistantMessageEventStream,
    model: Model<Api>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    console.warn(`Agentic Chat: model stream ${plan.classified.class} (attempt ${attempt + 1}/${maxRetries}) retrying in ${plan.delay}ms: ${plan.classified.message.slice(0, 200)}`);
    return this.sleepOrAbort(outcome.buffered, outer, model, plan.delay, signal);
  }

  private shouldRetryStream(
    classified: ReturnType<typeof classifyError>,
    hadContent: boolean,
    attempt: number,
    maxRetries: number,
    signal?: AbortSignal,
  ): boolean {
    return !hadContent && classified.retryable && attempt < maxRetries && !signal?.aborted && classified.class !== "resource" && classified.class !== "aborted" && classified.class !== "model" && classified.class !== "permanent";
  }

  private exceedsMaxDelay(delay: number, maxDelay: number | undefined): boolean {
    return maxDelay !== undefined && maxDelay > 0 && delay > maxDelay;
  }

  private async sleepOrAbort(buffered: unknown[], outer: AssistantMessageEventStream, model: Model<Api>, delay: number, signal?: AbortSignal): Promise<boolean> {
    try {
      await sleep(delay, signal);
      return true;
    } catch {
      for (const event of buffered) outer.push(event as never);
      this.pushStreamError(outer, model, "aborted", "aborted");
      return false;
    }
  }

  private pushStreamError(outer: AssistantMessageEventStream, model: Model<Api>, reason: StopReason, errorMessage: string): void {
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
  }
}
