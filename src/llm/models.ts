import { type Model, type OpenAICompletionsCompat, type OpenRouterRouting } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { requestUrl } from "obsidian";
import { resolveModelInfoSync, resolveModelPricingSync } from "./pricing-cache";
export { initPricingCache } from "./pricing-cache";

/** Canonical reasoning-effort ladder, lowest → highest, in UI order. */
export const THINKING_LEVEL_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Thinking levels a model actually supports, in UI order. A model without
 * `reasoning` only ever offers `"off"`. For reasoning models, a `thinkingLevelMap`
 * entry explicitly set to `null` marks that level as unsupported (per the pi-ai
 * contract); missing entries use provider defaults and stay available — except
 * `"xhigh"`, which is opt-in: a map without an explicit `xhigh` entry does NOT
 * advertise it (mirrors pi-ai's own `getSupportedThinkingLevels`). With no map
 * at all every level is offered (the provider applies its own default).
 * `"off"` is always available — it means "don't request reasoning".
 */
export function supportedThinkingLevels(
  model: Pick<Model<"openai-completions">, "reasoning" | "thinkingLevelMap">,
): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  const map = model.thinkingLevelMap;
  if (!map) return [...THINKING_LEVEL_ORDER];
  return THINKING_LEVEL_ORDER.filter((level) => {
    const mapped = map[level];
    if (mapped === null) return false;
    // xhigh is opt-in: it must have an explicit map entry, otherwise the
    // provider ignores/rejects it — so never advertise it on a missing key.
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}

/**
 * Clamp a requested level to one the model supports: the requested level when
 * supported, otherwise the highest supported level at or below it (preserving
 * the user's intent as closely as possible), falling back to `"off"`. Keeps us
 * from ever sending an unsupported level (e.g. `xhigh` to a model that caps at
 * `high`) — the model would otherwise ignore or reject it.
 */
export function clampThinkingLevel(requested: ThinkingLevel, supported: readonly ThinkingLevel[]): ThinkingLevel {
  if (supported.includes(requested)) return requested;
  for (let index = THINKING_LEVEL_ORDER.indexOf(requested); index >= 0; index -= 1) {
    const candidate = THINKING_LEVEL_ORDER[index];
    if (supported.includes(candidate)) return candidate;
  }
  return "off";
}

/** Provider routing constraints enforced on every OpenRouter request. */
export interface PrivacySettings {
  /** Only route to providers that do not store or train on prompts (`data_collection: "deny"`). */
  denyDataCollection: boolean;
  /** Only route to Zero Data Retention endpoints (`zdr: true`). Strictest option. */
  requireZDR: boolean;
  /** Allow OpenRouter to fall back to other policy-compliant providers. */
  allowFallbacks: boolean;
}

export type ProviderId = "openrouter" | "ollama" | "openai-compatible";

export interface ModelConfig {
  provider: ProviderId;
  /** OpenRouter model id, Ollama tag, or OpenAI-compatible model id. */
  modelId: string;
  privacy: PrivacySettings;
  /** Base URL of the local Ollama server (OpenAI-compatible endpoint is `${baseUrl}/v1`). */
  ollamaBaseUrl: string;
  /** Base URL whose `/chat/completions` endpoint follows the OpenAI chat completions API. */
  openaiCompatibleBaseUrl: string;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = "http://localhost:3000/api";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** Build the pi-ai model the agent streams through, applying privacy routing. */
export function buildModel(config: ModelConfig): Model<"openai-completions"> {
  if (config.provider === "ollama") return buildOllamaModel(config);
  if (config.provider === "openai-compatible") return buildOpenAICompatibleModel(config);
  return buildOpenRouterModel(config);
}

function buildOpenRouterModel(config: ModelConfig): Model<"openai-completions"> {
  const pricing = resolveModelPricingSync("openrouter", config.modelId);
  const info = resolveModelInfoSync("openrouter", config.modelId);
  const model: Model<"openai-completions"> = {
    id: config.modelId,
    name: info?.n ?? config.modelId,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: info ? info.re === 1 : true,
    input: ["text"],
    cost: { input: pricing.input, output: pricing.output, cacheRead: pricing.cacheRead, cacheWrite: pricing.cacheWrite },
    contextWindow: info?.c ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: info?.m ?? DEFAULT_MAX_TOKENS,
    ...(info?.tlm ? { thinkingLevelMap: info.tlm } : {}),
  };
  model.compat = { ...model.compat, openRouterRouting: buildOpenRouterRouting(config.privacy) };
  return model;
}

function buildOllamaModel(config: ModelConfig): Model<"openai-completions"> {
  const baseUrl = `${normalizeBaseUrl(config.ollamaBaseUrl, DEFAULT_OLLAMA_BASE_URL)}/v1`;
  return {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: "ollama",
    baseUrl,
    reasoning: false,
    input: ["text"],
    // Local inference is free; pi-ai computes cost from these per-million rates.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: { supportsUsageInStreaming: true },
  };
}

function buildOpenAICompatibleModel(config: ModelConfig): Model<"openai-completions"> {
  const pricing = resolveModelPricingSync("openai-compatible", config.modelId);
  return {
    id: config.modelId,
    name: config.modelId,
    api: "openai-completions",
    provider: "openai-compatible",
    baseUrl: normalizeOpenAICompatibleApiBaseUrl(config.openaiCompatibleBaseUrl),
    reasoning: false,
    input: ["text"],
    cost: { input: pricing.input, output: pricing.output, cacheRead: pricing.cacheRead, cacheWrite: pricing.cacheWrite },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      supportsReasoningEffort: false,
      supportsStore: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    },
  };
}

function normalizeBaseUrl(value: string, fallback: string): string {
  return (value.trim() || fallback).replace(/\/+$/, "");
}

export function buildOpenRouterRouting(privacy: PrivacySettings): OpenRouterRouting {
  const routing: OpenRouterRouting = { allow_fallbacks: privacy.allowFallbacks };
  if (privacy.denyDataCollection) routing.data_collection = "deny";
  if (privacy.requireZDR) routing.zdr = true;
  return routing;
}



export interface OpenRouterModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  supportsTools: boolean;
  supportsReasoning?: boolean;
}

/**
 * Human-friendly context window size, e.g. `1M`, `128k`, `512`. Returns an
 * empty string when the size is unknown so callers can omit the suffix.
 */
export function formatContextWindow(contextLength: number | null | undefined): string {
  if (!contextLength || contextLength <= 0) return "";
  if (contextLength >= 1_000_000) return `${trimDecimal(contextLength / 1_000_000)}M`;
  if (contextLength >= 1_000) return `${Math.round(contextLength / 1_000)}k`;
  return String(contextLength);
}

function trimDecimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

const DEFAULT_LIST_TIMEOUT_MS = 30_000;

export class ModelListError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ModelListError";
  }
}

/**
 * Fetch the live OpenRouter catalog for the model browser. The privacy filters
 * mirror the active routing so the browser never offers a model the routing
 * can't reach (which would 404 at request time): `zdr: true` restricts to
 * zero-data-retention endpoints and `denyDataCollection: true` restricts to
 * providers with a `deny` data policy.
 */
export async function listOpenRouterModels(
  apiKey: string,
  options?: {
    baseUrl?: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    zdr?: boolean;
    denyDataCollection?: boolean;
  },
): Promise<OpenRouterModelInfo[]> {
  const baseUrl = (options?.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/$/, "");
  const query = new URLSearchParams();
  if (options?.zdr) query.set("zdr", "true");
  if (options?.denyDataCollection) query.set("data_collection", "deny");
  const suffix = query.toString();
  const queryPart = suffix ? `?${suffix}` : "";
  const url = `${baseUrl}/models${queryPart}`;
  return fetchModelListCatalog(url, apiKey, options);
}

interface ModelListFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Fetch and normalize an OpenAI-style `/models` catalog. Uses the injected
 * `fetchImpl` (with AbortController-based timeout) when provided, otherwise
 * Obsidian's `requestUrl` wrapped in `withTimeout`.
 */
async function fetchModelListCatalog(
  url: string,
  apiKey: string,
  options?: ModelListFetchOptions,
): Promise<OpenRouterModelInfo[]> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  let status: number;
  let payload: {
    data?: Array<ModelListItem>;
  } | null;
  try {
    if (options?.fetchImpl) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await options.fetchImpl(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        status = response.status;
        const responsePayload: unknown = await response.json();
        payload = isModelListPayload(responsePayload) ? responsePayload : null;
      } finally {
        window.clearTimeout(timer);
      }
    } else {
      const response = await withTimeout(
        requestUrl({
          url,
          headers: { Authorization: `Bearer ${apiKey}` },
          throw: false,
        }),
        timeoutMs,
      );
      status = response.status;
      payload = response.json as typeof payload;
    }
  } catch (error) {
    if (error instanceof RequestTimeoutError || isAbortError(error)) {
      throw new ModelListError("Timed out while listing models.", 408);
    }
    throw new ModelListError(`Failed to list models: ${(error as Error).message}`);
  }
  if (status < 200 || status >= 300) {
    throw new ModelListError(`Failed to list models (status ${status}).`, status);
  }
  return (payload?.data ?? []).map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    contextLength: model.context_length ?? null,
    supportsTools: (model.supported_parameters ?? []).includes("tools"),
    supportsReasoning: modelSupportsReasoning(model),
  }));
}

/**
 * Fetch a generic OpenAI-compatible `/models` list. Unlike OpenRouter, most
 * gateways do not expose reliable tool/reasoning metadata, so callers should
 * present the returned ids as plain model choices instead of inferring feature
 * support from the catalog.
 */
export async function listOpenAICompatibleModels(
  apiKey: string,
  options: {
    baseUrl: string;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<OpenRouterModelInfo[]> {
  const url = openAICompatibleModelsUrl(options.baseUrl);
  return fetchModelListCatalog(url, apiKey, options);
}

function openAICompatibleModelsUrl(baseUrl: string): string {
  const normalized = normalizeOpenAICompatibleApiBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(normalized)) return normalized.replace(/\/chat\/completions$/i, "/models");
  return `${normalized}/models`;
}

export function normalizeOpenAICompatibleApiBaseUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl, DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
  try {
    const url = new URL(normalized);
    if (url.pathname === "" || url.pathname === "/") {
      url.pathname = "/api";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    // Keep the original normalization for relative or otherwise non-URL test doubles.
  }
  return normalized;
}

class RequestTimeoutError extends Error {}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function isModelListPayload(
  value: unknown,
): value is {
  data?: ModelListItem[];
} {
  if (typeof value !== "object" || value === null) return false;
  if (!("data" in value) || value.data === undefined) return true;
  return (
    Array.isArray(value.data) &&
    value.data.every(
      (model: unknown) =>
        typeof model === "object" &&
        model !== null &&
        "id" in model &&
        typeof model.id === "string" &&
        (!("name" in model) || model.name === undefined || typeof model.name === "string") &&
        (!("context_length" in model) ||
          model.context_length === undefined ||
          typeof model.context_length === "number") &&
        (!("supported_parameters" in model) ||
          model.supported_parameters === undefined ||
          (Array.isArray(model.supported_parameters) &&
            model.supported_parameters.every((parameter: unknown) => typeof parameter === "string"))) &&
        (!("supports_reasoning" in model) ||
          model.supports_reasoning === undefined ||
          typeof model.supports_reasoning === "boolean") &&
        (!("reasoning" in model) || model.reasoning === undefined || typeof model.reasoning === "object"),
    )
  );
}

interface ModelListItem {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  supports_reasoning?: boolean;
  reasoning?: { supported_efforts?: string[] | null } | null;
}

function modelSupportsReasoning(model: ModelListItem): boolean {
  if (typeof model.supports_reasoning === "boolean") return model.supports_reasoning;
  if (model.reasoning && typeof model.reasoning === "object") return true;
  return (model.supported_parameters ?? []).includes("reasoning");
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new RequestTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

// Keep the OpenAICompletionsCompat type referenced so downstream imports resolve.
export type { OpenAICompletionsCompat };
