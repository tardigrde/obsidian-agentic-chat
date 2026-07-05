import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentObservabilityRuntime } from "../src/observability/agent-observability";
import { buildOtlpTraceRequest, observabilityAuthHeaders, observabilityTraceEndpoint } from "../src/observability/otlp";
import { DEFAULT_SETTINGS, mergeSettings, type AgenticChatSettings } from "../src/settings";
import type { WebFetcher, WebHttpRequest } from "../src/tools/web-fetch";

describe("observability settings and OTLP export", () => {
  it("builds Langfuse OTLP requests without a built-in endpoint", () => {
    const settings = mergeSettings({
      observability: {
        ...DEFAULT_SETTINGS.observability,
        enabled: true,
        backend: "langfuse",
        endpoint: "https://langfuse.corp.example",
        langfusePublicKey: "pk-lf-public",
        langfuseSecretKey: "sk-lf-secret",
      },
    });

    expect(observabilityTraceEndpoint(settings.observability)).toBe(
      "https://langfuse.corp.example/api/public/otel/v1/traces",
    );
    expect(observabilityAuthHeaders(settings.observability)).toMatchObject({
      Authorization: `Basic ${btoa("pk-lf-public:sk-lf-secret")}`,
      "x-langfuse-ingestion-version": "4",
    });

    const request = buildOtlpTraceRequest({
      settings: settings.observability,
      spans: [
        {
          traceId: "1".repeat(32),
          spanId: "2".repeat(16),
          name: "agentic.turn",
          startTimeUnixNano: "1000000",
          endTimeUnixNano: "2000000",
        },
      ],
    });

    expect(request.url).toBe("https://langfuse.corp.example/api/public/otel/v1/traces");
    expect(request.headers?.Authorization).toBe(`Basic ${btoa("pk-lf-public:sk-lf-secret")}`);
    expect(request.headers?.["Content-Type"]).toBe("application/json");
  });

  it("supports generic OTLP endpoints and auth headers", () => {
    const settings = mergeSettings({
      observability: {
        ...DEFAULT_SETTINGS.observability,
        enabled: true,
        backend: "otlp",
        endpoint: "https://otel.corp.example/v1/traces",
        authHeaderName: "Authorization",
        authHeaderValue: "Bearer otel-token",
      },
    });

    expect(observabilityTraceEndpoint(settings.observability)).toBe("https://otel.corp.example/v1/traces");
    expect(observabilityAuthHeaders(settings.observability)).toEqual({ Authorization: "Bearer otel-token" });
  });

  it("exports metadata-only Langfuse traces without prompt or answer text", async () => {
    const requests: WebHttpRequest[] = [];
    const runtime = runtimeWithRequests(requests, {
      observability: {
        ...DEFAULT_SETTINGS.observability,
        enabled: true,
        backend: "langfuse",
        endpoint: "https://langfuse.corp.example",
        langfusePublicKey: "pk-lf-public",
        langfuseSecretKey: "sk-lf-secret",
        payloadMode: "metadata",
      },
    });

    runtime.handleAgentEvent({ type: "agent_start" });
    runtime.handleAgentEvent({ type: "message_end", message: userMessage("secret prompt api_key=hidden") });
    runtime.handleAgentEvent({ type: "message_start", message: assistantMessage("partial") });
    runtime.handleAgentEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "Note.md" } });
    runtime.recordApproval({ decision: "requested", toolCallId: "call-1", toolName: "read" });
    runtime.recordApproval({ decision: "approved", toolCallId: "call-1", toolName: "read" });
    runtime.handleAgentEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "tool result" }] },
      isError: false,
    });
    runtime.handleAgentEvent({ type: "message_end", message: assistantMessage("secret answer sk-should-not-leak") });
    await runtime.flush();

    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0].body ?? "{}") as OtlpBody;
    const spans = body.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((span) => span.name)).toEqual([
      "agentic.turn",
      "llm.generation",
      "tool.call",
      "approval.decision",
      "approval.decision",
    ]);
    expect(JSON.stringify(body)).not.toContain("secret prompt");
    expect(JSON.stringify(body)).not.toContain("secret answer");
    expect(JSON.stringify(body)).toContain("gen_ai.usage.input_tokens");
    expect(JSON.stringify(body)).toContain("agentic.tool.name");
    expect(runtime.getHealth()).toMatchObject({
      attemptedExports: 1,
      successfulExports: 1,
      failedExports: 0,
      lastStatus: 200,
      lastSpanCount: 5,
    });
  });

  it("exports redacted text previews only when payload mode allows it", async () => {
    const requests: WebHttpRequest[] = [];
    const runtime = runtimeWithRequests(requests, {
      observability: {
        ...DEFAULT_SETTINGS.observability,
        enabled: true,
        backend: "otlp",
        endpoint: "https://otel.corp.example/v1/traces",
        payloadMode: "redacted-previews",
      },
    });

    runtime.handleAgentEvent({ type: "agent_start" });
    runtime.handleAgentEvent({ type: "message_end", message: userMessage("hello access_token=super-secret") });
    runtime.handleAgentEvent({ type: "message_end", message: assistantMessage("answer Bearer supersecrettoken") });
    await runtime.flush();

    expect(requests).toHaveLength(1);
    const exported = JSON.stringify(JSON.parse(requests[0].body ?? "{}"));
    expect(exported).toContain("hello access_token=[redacted]");
    expect(exported).toContain("answer Bearer [redacted]");
    expect(exported).not.toContain("super-secret");
    expect(exported).not.toContain("supersecrettoken");
  });

  it("does not export when sampling drops the turn", async () => {
    const requests: WebHttpRequest[] = [];
    const runtime = runtimeWithRequests(
      requests,
      {
        observability: {
          ...DEFAULT_SETTINGS.observability,
          enabled: true,
          backend: "otlp",
          endpoint: "https://otel.corp.example/v1/traces",
          sampleRate: 0,
        },
      },
      { random: () => 0 },
    );

    runtime.handleAgentEvent({ type: "agent_start" });
    runtime.handleAgentEvent({ type: "message_end", message: assistantMessage("answer") });
    await runtime.flush();

    expect(requests).toHaveLength(0);
    expect(runtime.getHealth()).toMatchObject({
      attemptedExports: 0,
      successfulExports: 0,
      failedExports: 0,
      droppedTraces: 1,
    });
  });

  it("records failed export health without losing the error status", async () => {
    const requests: WebHttpRequest[] = [];
    const runtime = runtimeWithRequests(
      requests,
      {
        observability: {
          ...DEFAULT_SETTINGS.observability,
          enabled: true,
          backend: "otlp",
          endpoint: "https://otel.corp.example/v1/traces",
        },
      },
      { fetcher: async (request) => {
        requests.push(request);
        return { status: 503, text: "unavailable", headers: {} };
      } },
    );

    runtime.handleAgentEvent({ type: "agent_start" });
    runtime.handleAgentEvent({ type: "message_end", message: assistantMessage("answer") });
    await expect(runtime.flush()).rejects.toThrow(/HTTP 503/);

    expect(requests).toHaveLength(1);
    expect(runtime.getHealth()).toMatchObject({
      attemptedExports: 1,
      successfulExports: 0,
      failedExports: 1,
      lastStatus: 503,
    });
    expect(runtime.getHealth().lastError).toContain("HTTP 503");
  });

  it("does not call Langfuse until both project keys are configured", async () => {
    const requests: WebHttpRequest[] = [];
    const runtime = runtimeWithRequests(requests, {
      observability: {
        ...DEFAULT_SETTINGS.observability,
        enabled: true,
        backend: "langfuse",
        endpoint: "https://langfuse.corp.example",
        langfusePublicKey: "pk-lf-public",
        langfuseSecretKey: "",
      },
    });

    runtime.handleAgentEvent({ type: "agent_start" });
    runtime.handleAgentEvent({ type: "message_end", message: assistantMessage("answer") });
    await runtime.flush();

    expect(requests).toHaveLength(0);
  });
});

function runtimeWithRequests(
  requests: WebHttpRequest[],
  overrides: Partial<AgenticChatSettings>,
  options: { random?: () => number; fetcher?: WebFetcher } = {},
): AgentObservabilityRuntime {
  let idCounter = 1;
  let now = 1_000;
  const settings = mergeSettings({ ...DEFAULT_SETTINGS, ...overrides });
  const fetcher: WebFetcher = options.fetcher ?? (async (request) => {
    requests.push(request);
    return { status: 200, text: "", headers: {} };
  });
  return new AgentObservabilityRuntime({
    getSettings: () => settings,
    fetcher,
    getSessionContext: () => ({ sessionId: "session-1", sessionPath: "sessions/session-1.jsonl" }),
    now: () => {
      now += 10;
      return now;
    },
    random: options.random ?? (() => 0),
    idFactory: () => (idCounter++).toString(16).padStart(32, "0"),
  });
}

function userMessage(content: string): AgentMessage {
  return { role: "user", content, timestamp: 1 };
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openrouter",
    model: "test/model",
    usage: {
      input: 11,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
      cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
    },
    stopReason: "stop",
    timestamp: 2,
  };
}

interface OtlpBody {
  resourceSpans: Array<{
    scopeSpans: Array<{
      spans: Array<{ name: string }>;
    }>;
  }>;
}
