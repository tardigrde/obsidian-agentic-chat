import { getModels, type Model, type OpenAICompletionsCompat, type OpenRouterRouting } from "@earendil-works/pi-ai";
import { requestUrl } from "obsidian";

/** Provider routing constraints enforced on every OpenRouter request. */
export interface PrivacySettings {
  /** Only route to providers that do not store or train on prompts (`data_collection: "deny"`). */
  denyDataCollection: boolean;
  /** Only route to Zero Data Retention endpoints (`zdr: true`). Strictest option. */
  requireZDR: boolean;
  /** Allow OpenRouter to fall back to other policy-compliant providers. */
  allowFallbacks: boolean;
}

export type ProviderId = "openrouter" | "ollama";

export interface ModelConfig {
  provider: ProviderId;
  /** OpenRouter model id (e.g. `moonshotai/kimi-k2.6`) or Ollama tag (e.g. `llama3.1`). */
  modelId: string;
  privacy: PrivacySettings;
  /** Base URL of the local Ollama server (OpenAI-compatible endpoint is `${baseUrl}/v1`). */
  ollamaBaseUrl: string;
}

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

/** Build the pi-ai model the agent streams through, applying privacy routing. */
export function buildModel(config: ModelConfig): Model<"openai-completions"> {
  return config.provider === "ollama" ? buildOllamaModel(config) : buildOpenRouterModel(config);
}

function buildOpenRouterModel(config: ModelConfig): Model<"openai-completions"> {
  const base = findCatalogModel("openrouter", config.modelId);
  const model: Model<"openai-completions"> = base
    ? { ...base }
    : {
        id: config.modelId,
        name: config.modelId,
        api: "openai-completions",
        provider: "openrouter",
        baseUrl: OPENROUTER_BASE_URL,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
      };
  model.compat = { ...model.compat, openRouterRouting: buildRouting(config.privacy) };
  return model;
}

function buildOllamaModel(config: ModelConfig): Model<"openai-completions"> {
  const baseUrl = `${config.ollamaBaseUrl.replace(/\/+$/, "")}/v1`;
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

function buildRouting(privacy: PrivacySettings): OpenRouterRouting {
  const routing: OpenRouterRouting = { allow_fallbacks: privacy.allowFallbacks };
  if (privacy.denyDataCollection) routing.data_collection = "deny";
  if (privacy.requireZDR) routing.zdr = true;
  return routing;
}

function findCatalogModel(provider: "openrouter", id: string): Model<"openai-completions"> | undefined {
  try {
    const match = getModels(provider).find((model) => model.id === id);
    return match as Model<"openai-completions"> | undefined;
  } catch {
    return undefined;
  }
}

/** Per-million-token costs for a model id, if pi-ai's catalog knows it. */
export function catalogCost(provider: ProviderId, id: string): Model<"openai-completions">["cost"] | undefined {
  if (provider !== "openrouter") return undefined;
  return findCatalogModel("openrouter", id)?.cost;
}

export interface OpenRouterModelInfo {
  id: string;
  name: string;
  contextLength: number | null;
  supportsTools: boolean;
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
  const url = `${baseUrl}/models${suffix ? `?${suffix}` : ""}`;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
  let status: number;
  let payload: {
    data?: Array<{ id: string; name?: string; context_length?: number; supported_parameters?: string[] }>;
  } | null;
  try {
    if (options?.fetchImpl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await options.fetchImpl(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        status = response.status;
        payload = await response.json();
      } finally {
        clearTimeout(timer);
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
  }));
}

class RequestTimeoutError extends Error {}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RequestTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Keep the OpenAICompletionsCompat type referenced so downstream imports resolve.
export type { OpenAICompletionsCompat };
