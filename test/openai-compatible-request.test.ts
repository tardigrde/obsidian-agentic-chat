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
    const fetcher: WebFetcher = async (request) => {
      captured = request;
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
    });

    expect(captured).toMatchObject({
      url: "https://llm.example/api/chat/completions",
      method: "POST",
      headers: { Authorization: "Bearer test-key", "Content-Type": "application/json" },
      body: "{\"model\":\"x\"}",
    });
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
});
