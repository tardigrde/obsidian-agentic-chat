import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { buildModel } from "../src/llm/models";
import {
  createOpenAICompatibleRequester,
  streamOpenAICompatibleViaRequestUrl,
  type OpenAICompatibleRequest,
  type OpenAICompatibleRequester,
} from "../src/llm/openai-compatible-request";
import type { WebFetcher } from "../src/tools/web-fetch";

function model() {
  return buildModel({
    provider: "openai-compatible",
    modelId: "gemini-3.1-flash-lite",
    privacy: { denyDataCollection: true, requireZDR: true, allowFallbacks: false },
    ollamaBaseUrl: "http://localhost:11434",
    openaiCompatibleBaseUrl: "https://llm.example/api",
  });
}

function rootModel() {
  return buildModel({
    provider: "openai-compatible",
    modelId: "WARN-GLOBAL_kimi-k2.6",
    privacy: { denyDataCollection: true, requireZDR: true, allowFallbacks: false },
    ollamaBaseUrl: "http://localhost:11434",
    openaiCompatibleBaseUrl: "https://openwebui.example.com/",
  });
}

function openRouterModel() {
  return buildModel({
    provider: "openrouter",
    modelId: "openai/gpt-4o-mini",
    privacy: { denyDataCollection: true, requireZDR: true, allowFallbacks: false },
    ollamaBaseUrl: "http://localhost:11434",
    openaiCompatibleBaseUrl: "https://llm.example/api",
  });
}

async function collect(stream: ReturnType<typeof streamOpenAICompatibleViaRequestUrl>) {
  const events = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

describe("streamOpenAICompatibleViaRequestUrl", () => {
  it("adapts a WebFetcher into an OpenAI-compatible requester", async () => {
    let captured: Parameters<WebFetcher>[0] | undefined;
    let capturedSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const fetcher: WebFetcher = async (request, signal) => {
      captured = request;
      capturedSignal = signal;
      return {
        status: 200,
        text: "{\"ok\":true}",
        headers: { "content-type": "application/json" },
      };
    };

    const response = await createOpenAICompatibleRequester(fetcher)({
      url: "https://llm.example/api/chat/completions",
      method: "POST",
      contentType: "application/json",
      headers: { Authorization: "Bearer test-key" },
      body: "{\"model\":\"x\"}",
      signal: controller.signal,
    });

    expect(captured).toMatchObject({
      url: "https://llm.example/api/chat/completions",
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: "{\"model\":\"x\"}",
    });
    expect(capturedSignal).toBe(controller.signal);
    expect(response.json).toEqual({ ok: true });
  });

  it("posts a non-streaming chat completion through requestUrl and emits text", async () => {
    let captured: OpenAICompatibleRequest | undefined;
    const requester: OpenAICompatibleRequester = async (request) => {
      captured = request;
      return {
        status: 200,
        text: "",
        headers: { "content-type": "application/json" },
        json: {
          id: "chatcmpl_1",
          model: "gemini-3.1-flash-lite",
          choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        },
      };
    };

    const stream = streamOpenAICompatibleViaRequestUrl(
      model(),
      { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
      { apiKey: "test-key", temperature: 0.2, maxTokens: 32 },
      requester,
    );

    const { events, result } = await collect(stream);
    expect(captured?.url).toBe("https://llm.example/api/chat/completions");
    expect(captured?.headers?.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(captured?.body ?? "{}")).toMatchObject({
      model: "gemini-3.1-flash-lite",
      stream: false,
      temperature: 0.2,
      max_tokens: 32,
    });
    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    expect(result.usage.totalTokens).toBe(4);
  });

  it("posts chat completions under /api for bare OpenWebUI roots", async () => {
    let captured: OpenAICompatibleRequest | undefined;
    const requester: OpenAICompatibleRequester = async (request) => {
      captured = request;
      return {
        status: 200,
        text: "",
        json: {
          choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        },
      };
    };

    await collect(
      streamOpenAICompatibleViaRequestUrl(
        rootModel(),
        { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
        { apiKey: "test-key" },
        requester,
      ),
    );

    expect(captured?.url).toBe("https://openwebui.example.com/api/chat/completions");
  });

  it("converts tool schemas and emits returned tool calls", async () => {
    let payload: Record<string, unknown> = {};
    const requester: OpenAICompatibleRequester = async (request) => {
      payload = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      return {
        status: 200,
        text: "",
        json: {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_read",
                    type: "function",
                    function: { name: "read", arguments: "{\"path\":\"Welcome.md\"}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      };
    };
    const context: Context = {
      messages: [{ role: "user", content: "read Welcome.md", timestamp: 1 }],
      tools: [
        {
          name: "read",
          description: "Read a vault file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        } as unknown as NonNullable<Context["tools"]>[number],
      ],
    };

    const { events, result } = await collect(
      streamOpenAICompatibleViaRequestUrl(model(), context, { apiKey: "test-key" }, requester),
    );

    expect(payload.tools).toEqual([
      {
        type: "function",
        function: {
          name: "read",
          description: "Read a vault file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ]);
    expect(events.map((event) => event.type)).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "toolCall", id: "call_read", name: "read", arguments: { path: "Welcome.md" } },
    ]);
  });

  it("suppresses provider-returned reasoning content when reasoning is off", async () => {
    const requester: OpenAICompatibleRequester = async () => ({
      status: 200,
      text: "",
      json: {
        choices: [
          {
            message: {
              role: "assistant",
              reasoning_content: "hidden chain",
              content: "visible answer",
            },
            finish_reason: "stop",
          },
        ],
      },
    });

    const { events, result } = await collect(
      streamOpenAICompatibleViaRequestUrl(
        model(),
        { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
        { apiKey: "test-key" },
        requester,
      ),
    );

    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(result.content).toEqual([{ type: "text", text: "visible answer" }]);
  });

  it("emits provider-returned reasoning content when reasoning is explicitly enabled", async () => {
    const requester: OpenAICompatibleRequester = async () => ({
      status: 200,
      text: "",
      json: {
        choices: [
          {
            message: {
              role: "assistant",
              reasoning_content: "visible reasoning",
              content: "visible answer",
            },
            finish_reason: "stop",
          },
        ],
      },
    });

    const { events, result } = await collect(
      streamOpenAICompatibleViaRequestUrl(
        model(),
        { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
        { apiKey: "test-key", reasoning: "low" },
        requester,
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect(result.content).toEqual([
      { type: "thinking", thinking: "visible reasoning", thinkingSignature: "reasoning_content" },
      { type: "text", text: "visible answer" },
    ]);
  });

  it("keeps a tools field on follow-up turns with tool history", async () => {
    let payload: Record<string, unknown> = {};
    const requester: OpenAICompatibleRequester = async (request) => {
      payload = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      return {
        status: 200,
        text: "",
        json: {
          choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        },
      };
    };

    await collect(
      streamOpenAICompatibleViaRequestUrl(
        model(),
        {
          messages: [
            { role: "user", content: "read Welcome.md", timestamp: 1 },
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call_read",
                  name: "read",
                  arguments: { path: "Welcome.md" },
                },
              ],
              api: "openai-completions",
              provider: "openai-compatible",
              model: "gemini-3.1-flash-lite",
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "toolUse",
              timestamp: 2,
            },
            {
              role: "toolResult",
              toolCallId: "call_read",
              toolName: "read",
              content: [{ type: "text", text: "# Welcome" }],
              isError: false,
              timestamp: 3,
            },
          ],
        },
        { apiKey: "test-key" },
        requester,
      ),
    );

    expect(payload.tools).toEqual([]);
  });

  it("preserves OpenRouter privacy routing when using the requestUrl fallback", async () => {
    let payload: Record<string, unknown> = {};
    const requester: OpenAICompatibleRequester = async (request) => {
      payload = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
      return {
        status: 200,
        text: "",
        json: {
          choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
        },
      };
    };

    await collect(
      streamOpenAICompatibleViaRequestUrl(
        openRouterModel(),
        { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
        { apiKey: "test-key" },
        requester,
      ),
    );

    expect(payload.provider).toEqual({
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
    });
  });

  it("surfaces non-2xx responses as stream errors", async () => {
    const requester: OpenAICompatibleRequester = async () => ({
      status: 401,
      text: "{\"error\":{\"message\":\"Unauthorized\"}}",
      json: { error: { message: "Unauthorized" } },
    });

    const { events, result } = await collect(
      streamOpenAICompatibleViaRequestUrl(
        model(),
        { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
        { apiKey: "bad-key" },
        requester,
      ),
    );

    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("status 401");
    expect(result.errorMessage).toContain("Unauthorized");
  });

  it("retries transient OpenAI-compatible gateway errors", async () => {
    let attempts = 0;
    const requester: OpenAICompatibleRequester = async () => {
      attempts += 1;
      if (attempts === 1) {
        return {
          status: 400,
          text: "{\"detail\":\"Open WebUI: Server Connection Error\"}",
          json: { detail: "Open WebUI: Server Connection Error" },
        };
      }
      return {
        status: 200,
        text: "",
        json: {
          choices: [{ message: { role: "assistant", content: "recovered" }, finish_reason: "stop" }],
        },
      };
    };

    const { events, result } = await collect(
      streamOpenAICompatibleViaRequestUrl(
        model(),
        { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
        { apiKey: "test-key", maxRetries: 1 },
        requester,
      ),
    );

    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
  });

  it("finishes as aborted when the signal fires before requestUrl returns", async () => {
    let resolveRequest: ((response: Awaited<ReturnType<OpenAICompatibleRequester>>) => void) | undefined;
    const requester: OpenAICompatibleRequester = () =>
      new Promise((resolve) => {
        resolveRequest = resolve;
      });
    const controller = new AbortController();
    const pending = collect(
      streamOpenAICompatibleViaRequestUrl(
        model(),
        { messages: [{ role: "user", content: "ping", timestamp: 1 }] },
        { apiKey: "test-key", signal: controller.signal },
        requester,
      ),
    );

    controller.abort();
    const { events, result } = await pending;
    resolveRequest?.({
      status: 200,
      text: "",
      json: {
        choices: [{ message: { role: "assistant", content: "late" }, finish_reason: "stop" }],
      },
    });

    expect(events.map((event) => event.type)).toEqual(["error"]);
    expect(result.stopReason).toBe("aborted");
    expect(result.content).toEqual([]);
  });
});
