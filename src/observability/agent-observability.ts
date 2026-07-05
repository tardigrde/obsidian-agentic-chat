import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import type { WebFetcher } from "../tools/web-fetch";
import type { ApprovalAuditInput } from "../agent/action-audit-log";
import { redactText } from "../privacy/redaction";
import { exportOtlpSpans, observabilityTraceEndpoint, OtlpExportError, type OtlpAttributeValue, type OtlpSpan } from "./otlp";
import type { ObservabilityPayloadMode, ObservabilitySettings } from "./settings";

export interface AgentObservabilityRuntimeOptions {
  getSettings: () => AgenticChatSettings;
  fetcher: WebFetcher;
  getSessionContext: () => ObservabilitySessionContext;
  now?: () => number;
  random?: () => number;
  idFactory?: () => string;
}

export interface ObservabilitySessionContext {
  sessionId?: string | null;
  sessionPath?: string | null;
}

interface MutableSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs?: number;
  attributes: Record<string, OtlpAttributeValue>;
  status?: OtlpSpan["status"];
}

interface ActiveTrace {
  settings: ObservabilitySettings;
  traceId: string;
  root: MutableSpan;
  spans: MutableSpan[];
  toolSpans: Map<string, MutableSpan>;
  generationSpan: MutableSpan | null;
  sampled: boolean;
}

export interface ObservabilityExportHealth {
  attemptedExports: number;
  successfulExports: number;
  failedExports: number;
  droppedTraces: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastStatus: number | null;
  lastSpanCount: number | null;
}

const REDACTED_PREVIEW_CHARS = 500;
export class AgentObservabilityRuntime {
  private active: ActiveTrace | null = null;
  private readonly health: ObservabilityExportHealth = {
    attemptedExports: 0,
    successfulExports: 0,
    failedExports: 0,
    droppedTraces: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    lastStatus: null,
    lastSpanCount: null,
  };
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly idFactory: () => string;

  constructor(private readonly options: AgentObservabilityRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.idFactory = options.idFactory ?? (() => randomHex(16));
  }

  handleAgentEvent(event: AgentEvent): void {
    try {
      this.handleEvent(event);
    } catch (error) {
      console.warn(`Agentic Chat observability: ${errorMessage(error)}`);
    }
  }

  recordApproval(input: ApprovalAuditInput): void {
    try {
      const trace = this.active;
      if (!trace?.sampled) return;
      const parent = trace.toolSpans.get(input.toolCallId) ?? trace.root;
      const span = this.startSpan(trace, "approval.decision", parent.spanId, {
        "langfuse.observation.type": "event",
        "agentic.approval.decision": input.decision,
        "agentic.tool.name": input.toolName,
        "agentic.tool.call_id": input.toolCallId,
      });
      if (input.reason) span.attributes["agentic.approval.reason"] = safePreview(input.reason);
      this.endSpan(span, { code: input.decision === "denied" ? "error" : "ok", message: input.reason });
    } catch (error) {
      console.warn(`Agentic Chat observability approval event failed: ${errorMessage(error)}`);
    }
  }

  async flush(): Promise<void> {
    const trace = this.active;
    this.active = null;
    if (!trace?.sampled) return;
    await this.exportTrace(trace);
  }

  getHealth(): ObservabilityExportHealth {
    return { ...this.health };
  }

  private handleEvent(event: AgentEvent): void {
    if (event.type === "agent_start") {
      this.startTrace();
      return;
    }
    const trace = this.active;
    if (!trace?.sampled) return;

    if (event.type === "message_end") {
      this.captureMessageEnd(trace, event.message);
      return;
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.startGeneration(trace, event.message);
      return;
    }
    if (event.type === "tool_execution_start") {
      this.startTool(trace, event.toolCallId, event.toolName);
      return;
    }
    if (event.type === "tool_execution_end") {
      this.endTool(trace, event.toolCallId, event.toolName, event.isError);
      return;
    }
    if (event.type === "agent_end") {
      this.endSpan(trace.root, { code: "ok" });
      void this.flush().catch((error) => {
        console.warn(`Agentic Chat observability export failed: ${errorMessage(error)}`);
      });
    }
  }

  private startTrace(): void {
    const settings = { ...this.options.getSettings().observability };
    if (!settings.enabled || !observabilityTraceEndpoint(settings) || !hasRequiredAuth(settings)) {
      this.active = null;
      return;
    }
    const sampled = shouldSample(settings.sampleRate, this.random);
    if (!sampled) this.health.droppedTraces += 1;
    const context = this.options.getSettings();
    const session = this.options.getSessionContext();
    const traceId = this.traceId();
    const root = this.mutableSpan(traceId, "agentic.turn", undefined, {
      "langfuse.trace.name": "Agentic Chat turn",
      "langfuse.session.id": stableSessionId(session),
      "langfuse.trace.tags": ["agentic-chat", context.provider],
      "agentic.provider": context.provider,
      "agentic.model": activeModelIdForSettings(context),
      "agentic.mode": context.mode,
      "agentic.output_style": context.outputStyle,
      "agentic.thinking_level": context.thinkingLevel as ThinkingLevel,
      "agentic.observability.payload_mode": settings.payloadMode,
    });
    this.active = {
      settings,
      traceId,
      root,
      spans: [root],
      toolSpans: new Map(),
      generationSpan: null,
      sampled,
    };
  }

  private startGeneration(trace: ActiveTrace, message: AgentMessage): void {
    if (trace.generationSpan && !trace.generationSpan.endMs) this.endSpan(trace.generationSpan, { code: "unset" });
    const span = this.startSpan(trace, "llm.generation", trace.root.spanId, {
      "langfuse.observation.type": "generation",
      "agentic.message.role": "assistant",
    });
    addAssistantModelAttributes(span, message, trace.settings.payloadMode);
    trace.generationSpan = span;
  }

  private captureMessageEnd(trace: ActiveTrace, message: AgentMessage): void {
    if (message.role === "user") {
      addContentAttribute(trace.root, "langfuse.trace.input", messageText(message), trace.settings.payloadMode);
      trace.root.attributes["agentic.input_chars"] = messageText(message).length;
      return;
    }
    if (message.role !== "assistant") return;
    const generation = trace.generationSpan ?? this.startSpan(trace, "llm.generation", trace.root.spanId, {
      "langfuse.observation.type": "generation",
      "agentic.message.role": "assistant",
    });
    addAssistantModelAttributes(generation, message, trace.settings.payloadMode);
    addAssistantUsageAttributes(generation, message);
    const output = messageText(message);
    addContentAttribute(generation, "langfuse.observation.output", output, trace.settings.payloadMode);
    addContentAttribute(trace.root, "langfuse.trace.output", output, trace.settings.payloadMode);
    generation.attributes["agentic.output_chars"] = output.length;
    this.endSpan(generation, statusForAssistant(message));
    trace.generationSpan = null;
  }

  private startTool(trace: ActiveTrace, toolCallId: string, toolName: string): void {
    const span = this.startSpan(trace, "tool.call", trace.root.spanId, {
      "langfuse.observation.type": "span",
      "agentic.tool.name": toolName,
      "agentic.tool.call_id": toolCallId,
    });
    trace.toolSpans.set(toolCallId, span);
  }

  private endTool(trace: ActiveTrace, toolCallId: string, toolName: string, isError: boolean): void {
    const span = trace.toolSpans.get(toolCallId) ?? this.startSpan(trace, "tool.call", trace.root.spanId, {
      "langfuse.observation.type": "span",
      "agentic.tool.name": toolName,
      "agentic.tool.call_id": toolCallId,
    });
    span.attributes["agentic.tool.error"] = isError;
    this.endSpan(span, { code: isError ? "error" : "ok" });
    trace.toolSpans.delete(toolCallId);
  }

  private startSpan(
    trace: ActiveTrace,
    name: string,
    parentSpanId: string | undefined,
    attributes: Record<string, OtlpAttributeValue>,
  ): MutableSpan {
    const span = this.mutableSpan(trace.traceId, name, parentSpanId, attributes);
    trace.spans.push(span);
    return span;
  }

  private mutableSpan(
    traceId: string,
    name: string,
    parentSpanId: string | undefined,
    attributes: Record<string, OtlpAttributeValue>,
  ): MutableSpan {
    return {
      traceId,
      spanId: this.spanId(),
      parentSpanId,
      name,
      startMs: this.now(),
      attributes,
    };
  }

  private endSpan(span: MutableSpan, status: OtlpSpan["status"]): void {
    if (!span.endMs) span.endMs = this.now();
    span.status = status;
  }

  private async exportTrace(trace: ActiveTrace): Promise<void> {
    for (const span of trace.spans) {
      if (!span.endMs) this.endSpan(span, { code: "unset" });
    }
    const spans = trace.spans.map((span) => ({
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      startTimeUnixNano: unixNano(span.startMs),
      endTimeUnixNano: unixNano(span.endMs ?? span.startMs),
      attributes: span.attributes,
      status: span.status,
    }));
    this.recordExportAttempt(spans.length);
    try {
      const result = await exportOtlpSpans(
        {
          settings: trace.settings,
          serviceName: "agentic-chat",
          spans,
        },
        this.options.fetcher,
      );
      this.recordExportSuccess(result?.status ?? null);
    } catch (error) {
      this.recordExportFailure(error);
      throw error;
    }
  }

  private traceId(): string {
    return normalizeHex(this.idFactory(), 32);
  }

  private spanId(): string {
    return normalizeHex(this.idFactory(), 16);
  }

  private recordExportAttempt(spanCount: number): void {
    this.health.attemptedExports += 1;
    this.health.lastAttemptAt = new Date(this.now()).toISOString();
    this.health.lastSpanCount = spanCount;
  }

  private recordExportSuccess(status: number | null): void {
    this.health.successfulExports += 1;
    this.health.lastSuccessAt = new Date(this.now()).toISOString();
    this.health.lastStatus = status;
    this.health.lastError = null;
    this.health.lastErrorAt = null;
  }

  private recordExportFailure(error: unknown): void {
    this.health.failedExports += 1;
    this.health.lastErrorAt = new Date(this.now()).toISOString();
    this.health.lastError = errorMessage(error);
    this.health.lastStatus = error instanceof OtlpExportError ? error.status : null;
  }
}

function addAssistantModelAttributes(
  span: MutableSpan,
  message: AgentMessage,
  payloadMode: ObservabilityPayloadMode,
): void {
  if (message.role !== "assistant") return;
  span.attributes["gen_ai.system"] = message.provider;
  span.attributes["gen_ai.request.model"] = message.model;
  span.attributes["langfuse.observation.model.name"] = message.responseModel || message.model;
  span.attributes["agentic.stop_reason"] = message.stopReason;
  if (message.responseId) span.attributes["agentic.response_id"] = message.responseId;
  if (message.errorMessage) {
    span.attributes["agentic.error"] = true;
    if (payloadMode !== "metadata") span.attributes["agentic.error_message"] = safePreview(message.errorMessage);
  }
}

function addAssistantUsageAttributes(span: MutableSpan, message: AgentMessage): void {
  if (message.role !== "assistant") return;
  const usage = message.usage;
  span.attributes["gen_ai.usage.input_tokens"] = usage.input;
  span.attributes["gen_ai.usage.output_tokens"] = usage.output;
  span.attributes["gen_ai.usage.total_tokens"] = usage.totalTokens;
  span.attributes["gen_ai.usage.cost"] = usage.cost.total;
  span.attributes["langfuse.observation.usage_details"] = JSON.stringify(usageDetails(usage));
  span.attributes["langfuse.observation.cost_details"] = JSON.stringify(usage.cost);
}

function usageDetails(usage: Usage): Record<string, number> {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.totalTokens,
  };
}

function statusForAssistant(message: AgentMessage): OtlpSpan["status"] {
  if (message.role !== "assistant") return { code: "unset" };
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return { code: "error", message: message.errorMessage ?? message.stopReason };
  }
  return { code: "ok" };
}

function addContentAttribute(
  span: MutableSpan,
  key: string,
  value: string,
  payloadMode: ObservabilityPayloadMode,
): void {
  const exported = contentForMode(value, payloadMode);
  if (exported !== undefined) span.attributes[key] = exported;
}

function contentForMode(value: string, payloadMode: ObservabilityPayloadMode): string | undefined {
  if (!value) return undefined;
  if (payloadMode === "metadata") return undefined;
  if (payloadMode === "full-content") return value;
  return safePreview(value);
}

function safePreview(value: string): string {
  return redactText(value, { maxLength: REDACTED_PREVIEW_CHARS, redactHighEntropy: true });
}

function messageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function stableSessionId(context: ObservabilitySessionContext): string {
  const source = context.sessionId || context.sessionPath || "no-session";
  return `session-${fnv1a(source)}`;
}

function activeModelIdForSettings(settings: AgenticChatSettings): string {
  if (settings.provider === "ollama") return settings.ollamaModel;
  if (settings.provider === "openai-compatible") return settings.openaiCompatibleModel;
  return settings.openrouterModel;
}

function shouldSample(sampleRate: number, random: () => number): boolean {
  if (sampleRate <= 0) return false;
  if (sampleRate >= 100) return true;
  return random() * 100 < sampleRate;
}

function hasRequiredAuth(settings: ObservabilitySettings): boolean {
  if (settings.backend !== "langfuse") return true;
  return Boolean(settings.langfusePublicKey.trim() && settings.langfuseSecretKey.trim());
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(buffer);
  } else {
    for (let index = 0; index < buffer.length; index += 1) {
      buffer[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeHex(input: string, length: number): string {
  const hex = input.replace(/[^a-f0-9]/gi, "").toLowerCase();
  return (hex + "0".repeat(length)).slice(0, length);
}

function unixNano(ms: number): string {
  return String(BigInt(Math.max(0, Math.round(ms))) * 1_000_000n);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
