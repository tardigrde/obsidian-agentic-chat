import { normalizeMcpNoProxy, normalizeMcpProxyUrl } from "../mcp/settings";

export const OBSERVABILITY_LANGFUSE_PUBLIC_KEY_SECRET_ID = "agentic-chat-langfuse-public-key";
export const OBSERVABILITY_LANGFUSE_SECRET_KEY_SECRET_ID = "agentic-chat-langfuse-secret-key";
export const OBSERVABILITY_AUTH_HEADER_VALUE_SECRET_ID = "agentic-chat-observability-auth-header-value";

export type ObservabilityBackend = "langfuse" | "otlp";
export type ObservabilityPayloadMode = "metadata" | "redacted-previews" | "full-content";

export interface ObservabilitySettings {
  /** Opt-in telemetry export. Off by default; no endpoint is built in. */
  enabled: boolean;
  /** Langfuse is a convenience preset over OTLP/HTTP JSON. */
  backend: ObservabilityBackend;
  /** Langfuse base URL or generic OTLP /v1/traces endpoint, depending on backend. */
  endpoint: string;
  /** Optional observability-only HTTP proxy override. Empty inherits the global proxy. */
  proxyUrl: string;
  /** Comma-separated hosts/domains that bypass the observability proxy. */
  noProxy: string;
  /** 0-100 percentage of turns to export. */
  sampleRate: number;
  /** How much prompt/response text may leave the vault. */
  payloadMode: ObservabilityPayloadMode;
  /** Secret id in Obsidian secretStorage. */
  langfusePublicKeySecretId: string;
  /** Runtime-only hydrated Langfuse public key. */
  langfusePublicKey: string;
  /** Secret id in Obsidian secretStorage. */
  langfuseSecretKeySecretId: string;
  /** Runtime-only hydrated Langfuse secret key. */
  langfuseSecretKey: string;
  /** Optional generic OTLP auth header name, e.g. Authorization. */
  authHeaderName: string;
  /** Secret id in Obsidian secretStorage. */
  authHeaderValueSecretId: string;
  /** Runtime-only hydrated generic OTLP auth header value. */
  authHeaderValue: string;
}

export const DEFAULT_OBSERVABILITY_SETTINGS: ObservabilitySettings = {
  enabled: false,
  backend: "langfuse",
  endpoint: "",
  proxyUrl: "",
  noProxy: "localhost,127.0.0.1,::1",
  sampleRate: 100,
  payloadMode: "metadata",
  langfusePublicKeySecretId: OBSERVABILITY_LANGFUSE_PUBLIC_KEY_SECRET_ID,
  langfusePublicKey: "",
  langfuseSecretKeySecretId: OBSERVABILITY_LANGFUSE_SECRET_KEY_SECRET_ID,
  langfuseSecretKey: "",
  authHeaderName: "",
  authHeaderValueSecretId: OBSERVABILITY_AUTH_HEADER_VALUE_SECRET_ID,
  authHeaderValue: "",
};

const OBSERVABILITY_BACKENDS = new Set<ObservabilityBackend>(["langfuse", "otlp"]);
const OBSERVABILITY_PAYLOAD_MODES = new Set<ObservabilityPayloadMode>(["metadata", "redacted-previews", "full-content"]);

export function healObservabilitySettings(
  stored: Partial<ObservabilitySettings> | null | undefined,
): ObservabilitySettings {
  return {
    ...DEFAULT_OBSERVABILITY_SETTINGS,
    enabled: stored?.enabled === true,
    backend: healBackend(stored?.backend),
    endpoint: normalizeObservabilityEndpoint(stored?.endpoint),
    proxyUrl: normalizeMcpProxyUrl(stored?.proxyUrl),
    noProxy: normalizeMcpNoProxy(stored?.noProxy),
    sampleRate: clampSampleRate(stored?.sampleRate),
    payloadMode: healPayloadMode(stored?.payloadMode),
    langfusePublicKeySecretId: stringSetting(
      stored?.langfusePublicKeySecretId,
      OBSERVABILITY_LANGFUSE_PUBLIC_KEY_SECRET_ID,
    ),
    langfusePublicKey: stringSetting(stored?.langfusePublicKey, ""),
    langfuseSecretKeySecretId: stringSetting(
      stored?.langfuseSecretKeySecretId,
      OBSERVABILITY_LANGFUSE_SECRET_KEY_SECRET_ID,
    ),
    langfuseSecretKey: stringSetting(stored?.langfuseSecretKey, ""),
    authHeaderName: stringSetting(stored?.authHeaderName, ""),
    authHeaderValueSecretId: stringSetting(
      stored?.authHeaderValueSecretId,
      OBSERVABILITY_AUTH_HEADER_VALUE_SECRET_ID,
    ),
    authHeaderValue: stringSetting(stored?.authHeaderValue, ""),
  };
}

export function normalizeLangfuseOtlpTraceEndpoint(baseUrl: string): string {
  const normalized = normalizeObservabilityEndpoint(baseUrl);
  if (!normalized) return "";
  if (normalized.endsWith("/api/public/otel/v1/traces")) return normalized;
  if (normalized.endsWith("/api/public/otel")) return `${normalized}/v1/traces`;
  return `${normalized}/api/public/otel/v1/traces`;
}

function healBackend(value: unknown): ObservabilityBackend {
  return OBSERVABILITY_BACKENDS.has(value as ObservabilityBackend)
    ? (value as ObservabilityBackend)
    : DEFAULT_OBSERVABILITY_SETTINGS.backend;
}

function healPayloadMode(value: unknown): ObservabilityPayloadMode {
  return OBSERVABILITY_PAYLOAD_MODES.has(value as ObservabilityPayloadMode)
    ? (value as ObservabilityPayloadMode)
    : DEFAULT_OBSERVABILITY_SETTINGS.payloadMode;
}

function clampSampleRate(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_OBSERVABILITY_SETTINGS.sampleRate;
  return Math.min(100, Math.max(0, Math.round(numeric)));
}

function normalizeObservabilityEndpoint(value: unknown): string {
  const raw = stringSetting(value, "");
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function stringSetting(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}
