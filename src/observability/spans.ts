import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { redactText } from "../privacy/redaction";
import { fnv1a32 } from "../utils/hash";
import type { OtlpAttributeValue, OtlpSpan } from "./otlp";
import type { ObservabilityPayloadMode, ObservabilitySettings } from "./settings";

export interface MutableSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs?: number;
  attributes: Record<string, OtlpAttributeValue>;
  status?: OtlpSpan["status"];
}

export interface ActiveTrace {
  settings: ObservabilitySettings;
  traceId: string;
  root: MutableSpan;
  spans: MutableSpan[];
  toolSpans: Map<string, MutableSpan>;
  generationSpan: MutableSpan | null;
  sampled: boolean;
}

export interface ObservabilitySessionContext {
  sessionId?: string | null;
  sessionPath?: string | null;
}

const REDACTED_PREVIEW_CHARS = 500;

export function createMutableSpan(
  traceId: string,
  name: string,
  parentSpanId: string | undefined,
  attributes: Record<string, OtlpAttributeValue>,
  now: number,
  spanId: string,
): MutableSpan {
  return {
    traceId,
    spanId,
    parentSpanId,
    name,
    startMs: now,
    attributes,
  };
}

export function startSpan(
  trace: ActiveTrace,
  name: string,
  parentSpanId: string | undefined,
  attributes: Record<string, OtlpAttributeValue>,
  now: number,
  spanId: string,
): MutableSpan {
  const span = createMutableSpan(trace.traceId, name, parentSpanId, attributes, now, spanId);
  trace.spans.push(span);
  return span;
}

export function endSpan(span: MutableSpan, status: OtlpSpan["status"], now: number): void {
  if (!span.endMs) span.endMs = now;
  span.status = status;
}

/** Close any open spans and convert the trace into the OTLP wire shape. */
export function toOtlpSpans(trace: ActiveTrace, now: number): OtlpSpan[] {
  for (const span of trace.spans) {
    if (!span.endMs) endSpan(span, { code: "unset" }, now);
  }
  return trace.spans.map((span) => ({
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    startTimeUnixNano: unixNano(span.startMs),
    endTimeUnixNano: unixNano(span.endMs ?? span.startMs),
    attributes: span.attributes,
    status: span.status,
  }));
}

export function addAssistantModelAttributes(
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

export function addAssistantUsageAttributes(span: MutableSpan, message: AgentMessage): void {
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

export function statusForAssistant(message: AgentMessage): OtlpSpan["status"] {
  if (message.role !== "assistant") return { code: "unset" };
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return { code: "error", message: message.errorMessage ?? message.stopReason };
  }
  return { code: "ok" };
}

export function addContentAttribute(
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

export function safePreview(value: string): string {
  return redactText(value, { maxLength: REDACTED_PREVIEW_CHARS, redactHighEntropy: true });
}

export function messageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

export function stableSessionId(context: ObservabilitySessionContext): string {
  const source = context.sessionId || context.sessionPath || "no-session";
  return `session-${fnv1a(source)}`;
}

export function shouldSample(sampleRate: number, random: () => number): boolean {
  if (sampleRate <= 0) return false;
  if (sampleRate >= 100) return true;
  return random() * 100 < sampleRate;
}

export function hasRequiredAuth(settings: ObservabilitySettings): boolean {
  if (settings.backend !== "langfuse") return true;
  return Boolean(settings.langfusePublicKey.trim() && settings.langfuseSecretKey.trim());
}

export function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  window.crypto.getRandomValues(buffer);
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizeHex(input: string, length: number): string {
  const hex = input.replace(/[^a-f0-9]/gi, "").toLowerCase();
  return (hex + "0".repeat(length)).slice(0, length);
}

function unixNano(ms: number): string {
  return String(BigInt(Math.max(0, Math.round(ms))) * 1_000_000n);
}

function fnv1a(value: string): string {
  return fnv1a32(value, { codePoints: true }).toString(16).padStart(8, "0");
}
