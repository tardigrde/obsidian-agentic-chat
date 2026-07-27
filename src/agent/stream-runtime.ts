import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import {
  createOpenAICompatibleRequester,
  streamOpenAICompatibleViaRequestUrl,
} from "../llm/openai-compatible-request";
import { sharedAgentModels } from "../llm/providers";
import { createProxiedFetcher } from "../mcp/fetcher";

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
      return this.streamSimpleFn(model, context, streamOptions);
    };
  }
}
