import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { buildModel } from "../src/llm/models";
import { AgentStreamRuntime } from "../src/agent/stream-runtime";
import type { streamOpenAICompatibleViaRequestUrl } from "../src/llm/openai-compatible-request";

type CapturedCall = {
  model: Model<Api>;
  context: Context;
  options?: SimpleStreamOptions;
};
type CompatibleRequester = Parameters<typeof streamOpenAICompatibleViaRequestUrl>[3];
type CompatibleCapturedCall = CapturedCall & {
  requester?: CompatibleRequester;
};

function settings(overrides: Partial<AgenticChatSettings> = {}): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    temperature: 0.7,
    maxTokens: 64,
    requestTimeoutMs: 12_345,
    maxNetworkRetries: 3,
    ...overrides,
  };
}

function openRouterModel(): Model<"openai-completions"> {
  return buildModel({
    provider: "openrouter",
    modelId: "openai/gpt-4o-mini",
    privacy: { denyDataCollection: true, requireZDR: true, allowFallbacks: false },
    ollamaBaseUrl: "http://localhost:11434",
    openaiCompatibleBaseUrl: "http://localhost:3000/api",
  });
}

function openAICompatibleModel(): Model<"openai-completions"> {
  return buildModel({
    provider: "openai-compatible",
    modelId: "local/model",
    privacy: { denyDataCollection: true, requireZDR: true, allowFallbacks: false },
    ollamaBaseUrl: "http://localhost:11434",
    openaiCompatibleBaseUrl: "http://localhost:3000/api",
  });
}

function stream() {
  return createAssistantMessageEventStream();
}

describe("AgentStreamRuntime", () => {
  it("returns an injected stream function unchanged", () => {
    const injected: StreamFn = () => stream();
    const runtime = new AgentStreamRuntime({ getSettings: () => settings(), streamFn: injected });

    expect(runtime.buildStreamFn()).toBe(injected);
  });

  it("maps settings into stream options and lets caller headers override defaults", () => {
    const calls: CapturedCall[] = [];
    const streamSimpleFn = ((model, context, options) => {
      calls.push({ model, context, options });
      return stream();
    }) as typeof import("@earendil-works/pi-ai").streamSimple;
    const runtime = new AgentStreamRuntime({ getSettings: () => settings(), streamSimpleFn });
    const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
    const signal = new AbortController().signal;

    void runtime.buildStreamFn()(openRouterModel(), context, {
      apiKey: "test-key",
      signal,
      temperature: 0.1,
      maxTokens: 1,
      headers: { "X-Title": "Custom Title", "X-Extra": "1" },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].context).toBe(context);
    expect(calls[0].options).toMatchObject({
      apiKey: "test-key",
      signal,
      temperature: 0.7,
      maxTokens: 64,
      timeoutMs: 12_345,
      maxRetries: 3,
      headers: {
        "HTTP-Referer": "https://github.com/tardigrde/obsidian-agentic-chat",
        "X-Title": "Custom Title",
        "X-Extra": "1",
      },
    });
  });

  it("omits maxTokens when the setting delegates output length to the provider", () => {
    const calls: CapturedCall[] = [];
    const streamSimpleFn = ((model, context, options) => {
      calls.push({ model, context, options });
      return stream();
    }) as typeof import("@earendil-works/pi-ai").streamSimple;
    const runtime = new AgentStreamRuntime({ getSettings: () => settings({ maxTokens: 0 }), streamSimpleFn });

    void runtime.buildStreamFn()(openRouterModel(), { messages: [] });

    expect(calls[0].options).not.toHaveProperty("maxTokens");
  });

  it("routes OpenAI-compatible chat completions through the Obsidian requestUrl fallback", () => {
    const simpleCalls: CapturedCall[] = [];
    const compatibleCalls: CompatibleCapturedCall[] = [];
    const streamSimpleFn = ((model, context, options) => {
      simpleCalls.push({ model, context, options });
      return stream();
    }) as typeof import("@earendil-works/pi-ai").streamSimple;
    const openAICompatibleStreamFn: typeof streamOpenAICompatibleViaRequestUrl = (model, context, options, requester) => {
      compatibleCalls.push({ model, context, options, requester });
      return stream();
    };
    const runtime = new AgentStreamRuntime({
      getSettings: () => settings(),
      streamSimpleFn,
      openAICompatibleStreamFn,
    });
    const context: Context = { messages: [] };

    void runtime.buildStreamFn()(openAICompatibleModel(), context, { apiKey: "test-key" });

    expect(simpleCalls).toHaveLength(0);
    expect(compatibleCalls).toHaveLength(1);
    expect(compatibleCalls[0].context).toBe(context);
    expect(compatibleCalls[0].options).toMatchObject({ apiKey: "test-key", temperature: 0.7 });
    expect(compatibleCalls[0].requester).toBeUndefined();
  });

  it("routes OpenRouter through the requestUrl fallback when a global proxy is configured", () => {
    const simpleCalls: CapturedCall[] = [];
    const compatibleCalls: CompatibleCapturedCall[] = [];
    const streamSimpleFn = ((model, context, options) => {
      simpleCalls.push({ model, context, options });
      return stream();
    }) as typeof import("@earendil-works/pi-ai").streamSimple;
    const openAICompatibleStreamFn: typeof streamOpenAICompatibleViaRequestUrl = (model, context, options, requester) => {
      compatibleCalls.push({ model, context, options, requester });
      return stream();
    };
    const runtime = new AgentStreamRuntime({
      getSettings: () =>
        settings({
          network: { proxyUrl: "http://proxy.example:3128", noProxy: "localhost,127.0.0.1" },
        }),
      streamSimpleFn,
      openAICompatibleStreamFn,
    });
    const context: Context = { messages: [] };

    void runtime.buildStreamFn()(openRouterModel(), context, { apiKey: "test-key" });

    expect(simpleCalls).toHaveLength(0);
    expect(compatibleCalls).toHaveLength(1);
    expect(compatibleCalls[0].model.provider).toBe("openrouter");
    expect(compatibleCalls[0].requester).toEqual(expect.any(Function));
  });
});
