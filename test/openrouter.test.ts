import { describe, expect, it, vi } from "vitest";
import { OpenRouterError, OpenRouterModel, listModels } from "../src/llm/openrouter";
import type { PrivacySettings } from "../src/llm/openrouter";

const OPEN_PRIVACY: PrivacySettings = {
  denyDataCollection: false,
  requireZDR: false,
  allowFallbacks: true,
};

const STRICT_PRIVACY: PrivacySettings = {
  denyDataCollection: true,
  requireZDR: true,
  allowFallbacks: false,
};

function sseResponse(events: unknown[]): Response {
  const body =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function textChunks(text: string): unknown[] {
  return [
    ...[...text].map((char) => ({ choices: [{ delta: { content: char } }] })),
    {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
    },
  ];
}

type FetchMock = ReturnType<typeof vi.fn> & typeof fetch;

function makeModel(
  fetchImpl: typeof fetch,
  overrides: Partial<ConstructorParameters<typeof OpenRouterModel>[0]> = {},
): OpenRouterModel {
  return new OpenRouterModel({
    apiKey: "sk-or-test",
    model: "test/model",
    privacy: OPEN_PRIVACY,
    fetchImpl,
    ...overrides,
  });
}

function sentBody(fetchMock: FetchMock, call = 0): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls[call][1].body as string);
}

describe("OpenRouterModel.request", () => {
  it("assembles streamed text, usage, and finish reason", async () => {
    const fetchMock = vi.fn(async () => sseResponse(textChunks("Hi!"))) as FetchMock;
    const deltas: string[] = [];

    const response = await makeModel(fetchMock).request({
      messages: [{ role: "user", content: "hello" }],
      onDelta: (delta) => {
        if (delta.text) deltas.push(delta.text);
      },
    });

    expect(response.message).toEqual({ role: "assistant", content: "Hi!" });
    expect(deltas).toEqual(["H", "i", "!"]);
    expect(response.usage).toEqual({
      promptTokens: 12,
      completionTokens: 3,
      totalTokens: 15,
      requests: 1,
    });
    expect(response.finishReason).toBe("stop");
  });

  it("merges streamed tool-call fragments by index", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_a", function: { name: "read_note", arguments: "" } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] },
        {
          choices: [
            { delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"A.md"}' } }] } },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    ) as FetchMock;

    const response = await makeModel(fetchMock).request({
      messages: [{ role: "user", content: "go" }],
    });

    expect(response.message.content).toBeNull();
    expect(response.message.tool_calls).toEqual([
      {
        id: "call_a",
        type: "function",
        function: { name: "read_note", arguments: '{"path":"A.md"}' },
      },
    ]);
    expect(response.finishReason).toBe("tool_calls");
  });

  it("collects reasoning deltas separately from content", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { choices: [{ delta: { reasoning: "let me think" } }] },
        { choices: [{ delta: { content: "42" } }] },
      ]),
    ) as FetchMock;

    const response = await makeModel(fetchMock).request({
      messages: [{ role: "user", content: "?" }],
    });

    expect(response.message.content).toBe("42");
    expect(response.message.reasoning).toBe("let me think");
  });

  it("sends privacy-preserving provider preferences when enforced", async () => {
    const fetchMock = vi.fn(async () => sseResponse(textChunks("x"))) as FetchMock;

    await makeModel(fetchMock, { privacy: STRICT_PRIVACY }).request({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(sentBody(fetchMock).provider).toEqual({
      data_collection: "deny",
      zdr: true,
      allow_fallbacks: false,
    });
  });

  it("omits provider preferences entirely when privacy is not enforced", async () => {
    const fetchMock = vi.fn(async () => sseResponse(textChunks("x"))) as FetchMock;

    await makeModel(fetchMock).request({ messages: [{ role: "user", content: "hi" }] });

    const body = sentBody(fetchMock);
    expect(body.provider).toBeUndefined();
    expect(body.stream).toBe(true);
    expect(body.usage).toEqual({ include: true });
  });

  it("strips local-only reasoning metadata from outgoing messages", async () => {
    const fetchMock = vi.fn(async () => sseResponse(textChunks("x"))) as FetchMock;

    await makeModel(fetchMock).request({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo", reasoning: "private thoughts" },
      ],
    });

    const messages = sentBody(fetchMock).messages as Array<Record<string, unknown>>;
    expect(messages[1]).toEqual({ role: "assistant", content: "yo" });
  });

  it("sends auth and attribution headers", async () => {
    const fetchMock = vi.fn(async () => sseResponse(textChunks("x"))) as FetchMock;

    await makeModel(fetchMock).request({ messages: [{ role: "user", content: "hi" }] });

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-test");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Title"]).toBeTruthy();
    expect(headers["HTTP-Referer"]).toBeTruthy();
  });

  it("maps 401 to a friendly non-retryable error", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    ) as FetchMock;

    await expect(
      makeModel(fetchMock, { maxRetries: 3 }).request({
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/Invalid OpenRouter API key.*bad key/s);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 and succeeds on the next attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 }),
      )
      .mockResolvedValueOnce(sseResponse(textChunks("ok"))) as FetchMock;

    const response = await makeModel(fetchMock, { maxRetries: 1 }).request({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.message.content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("gives up after exhausting retries on server errors", async () => {
    const fetchMock = vi.fn(
      async () => new Response("oops", { status: 500 }),
    ) as FetchMock;

    await expect(
      makeModel(fetchMock, { maxRetries: 1 }).request({
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/status 500/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("throws on mid-stream error chunks", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { choices: [{ delta: { content: "par" } }] },
        { error: { message: "provider exploded", code: 502 } },
      ]),
    ) as FetchMock;

    await expect(
      makeModel(fetchMock).request({ messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/provider exploded/);
  });

  it("converts a hung request into a retryable timeout error", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ) as unknown as FetchMock;

    await expect(
      makeModel(fetchMock, { requestTimeoutMs: 20, maxRetries: 0 }).request({
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(/timed out/);
  });

  it("propagates user aborts without retrying", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ) as unknown as FetchMock;

    const pending = makeModel(fetchMock, { maxRetries: 3 }).request({
      messages: [{ role: "user", content: "hi" }],
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow(/abort/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("listModels", () => {
  it("maps the catalog and flags tool support", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                id: "a/tools",
                name: "Tools Model",
                context_length: 128000,
                supported_parameters: ["tools", "temperature"],
              },
              { id: "b/plain" },
            ],
          }),
          { status: 200 },
        ),
    ) as FetchMock;

    const models = await listModels("sk-or-test", { fetchImpl: fetchMock });

    expect(models).toEqual([
      { id: "a/tools", name: "Tools Model", contextLength: 128000, supportsTools: true },
      { id: "b/plain", name: "b/plain", contextLength: null, supportsTools: false },
    ]);
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-test");
  });

  it("throws an OpenRouterError on failure statuses", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 })) as FetchMock;

    await expect(listModels("bad", { fetchImpl: fetchMock })).rejects.toThrow(OpenRouterError);
  });
});
