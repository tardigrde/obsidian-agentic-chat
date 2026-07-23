import { requestUrl, type App, type DataAdapter, type Plugin } from "obsidian";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface CompactModelInfo {
  id: string;
  n: string; // name
  c: number; // context_length
  m: number; // max_completion_tokens
  pi: number; // input price per million tokens (rounded to 2 decimals)
  po: number; // output price per million tokens
  pr: number; // cache read price per million tokens
  pw: number; // cache write price per million tokens
  t: 0 | 1; // supports tools
  re: 0 | 1; // supports reasoning
  tlm: Record<ThinkingLevel, string | null> | null; // thinkingLevelMap
}

interface PricingCache {
  fetchedAt: number;
  models: Record<string, CompactModelInfo>;
}

const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const DEFAULT_TIMEOUT_MS = 30_000;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

let vaultAdapter: DataAdapter | null = null;
let cacheFilePath: string | null = null;
let inFlightPromise: Promise<PricingCache> | null = null;
let memoryCache: PricingCache | null = null;

export function initPricingCache(app: App, plugin: Plugin): void {
  vaultAdapter = app.vault.adapter;
  const pluginDir = plugin.manifest.dir ?? `${app.vault.configDir}/plugins/${plugin.manifest.id}`;
  cacheFilePath = `${pluginDir}/pricing-cache.json`;
  // Kick off a silent load so the in-memory cache is warm before the first
  // pricing lookup. If the file doesn't exist yet the async path will fetch it.
  void loadCacheIntoMemory();
}

/** Resolve full model info synchronously from the in-memory cache. */
export function resolveModelInfoSync(
  provider: "openrouter" | "ollama" | "openai-compatible",
  modelId: string,
): CompactModelInfo | undefined {
  if (provider === "ollama") return undefined;
  const cache = memoryCache;
  if (!cache) return undefined;
  return findInCache(cache, provider, modelId);
}

/** Resolve pricing for a model synchronously from the in-memory cache. */
export function resolveModelPricingSync(
  provider: "openrouter" | "ollama" | "openai-compatible",
  modelId: string,
): { input: number; output: number; cacheRead: number; cacheWrite: number; isUnknown: boolean } {
  if (provider === "ollama") {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, isUnknown: false };
  }

  const info = resolveModelInfoSync(provider, modelId);

  if (info) {
    return {
      input: info.pi,
      output: info.po,
      cacheRead: info.pr,
      cacheWrite: info.pw,
      isUnknown: false,
    };
  }

  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, isUnknown: true };
}

/** Async version: triggers a background refresh if cache is stale/missing. */
export async function resolveModelPricing(
  provider: "openrouter" | "ollama" | "openai-compatible",
  modelId: string,
): Promise<{ input: number; output: number; cacheRead: number; cacheWrite: number; isUnknown: boolean }> {
  if (provider === "ollama") {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, isUnknown: false };
  }

  const cache = await getCache();
  const info = findInCache(cache, provider, modelId);

  if (info) {
    return {
      input: info.pi,
      output: info.po,
      cacheRead: info.pr,
      cacheWrite: info.pw,
      isUnknown: false,
    };
  }

  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, isUnknown: true };
}

/** Synchronous check: is pricing currently unknown for this model? */
export function isPricingUnknown(
  provider: "openrouter" | "ollama" | "openai-compatible",
  modelId: string,
): boolean {
  if (provider === "ollama") return false;
  const cache = memoryCache;
  if (!cache) return true;
  return !findInCache(cache, provider, modelId);
}

function findInCache(cache: PricingCache, provider: string, modelId: string): CompactModelInfo | undefined {
  // Exact match
  if (cache.models[modelId]) return cache.models[modelId];

  // For openai-compatible, try suffix match (e.g. "gpt-4o" → "openai/gpt-4o")
  if (provider === "openai-compatible" && !modelId.includes("/")) {
    for (const key of Object.keys(cache.models)) {
      const suffix = key.slice(key.lastIndexOf("/") + 1);
      if (suffix === modelId) return cache.models[key];
    }
  }

  return undefined;
}

async function getCache(): Promise<PricingCache> {
  // Ensure memory cache is loaded first
  await loadCacheIntoMemory();

  if (memoryCache && Date.now() - memoryCache.fetchedAt < CACHE_TTL_MS) {
    return memoryCache;
  }

  // Stale or missing — refresh in background
  if (!inFlightPromise) {
    inFlightPromise = fetchAndStoreCache().finally(() => {
      inFlightPromise = null;
    });
  }

  // Return stale data while refreshing, or empty if none exists
  return memoryCache ?? { fetchedAt: 0, models: {} };
}

async function loadCacheIntoMemory(): Promise<void> {
  if (memoryCache) return;
  if (!cacheFilePath || !vaultAdapter) return;
  try {
    const raw = await vaultAdapter.read(cacheFilePath);
    if (!raw) return;
    const parsed: PricingCache = JSON.parse(raw);
    if (typeof parsed.fetchedAt !== "number" || typeof parsed.models !== "object") return;
    memoryCache = parsed;
  } catch {
    // File missing or corrupt — will be fetched later
  }
}

async function fetchAndStoreCache(): Promise<PricingCache> {
  try {
    const response = await withTimeout(
      requestUrl({ url: OPENROUTER_MODELS_URL, throw: false }),
      DEFAULT_TIMEOUT_MS,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenRouter models API returned ${response.status}`);
    }
    const payload = response.json as { data?: Array<Record<string, unknown>> } | null;
    const models = compactifyModels(payload?.data ?? []);
    const cache: PricingCache = { fetchedAt: Date.now(), models };
    await writeCache(cache);
    memoryCache = cache;
    return cache;
  } catch (error) {
    // On failure, keep stale memory cache if available
    if (memoryCache) return memoryCache;
    return { fetchedAt: 0, models: {} };
  }
}

function parsePrice(value: string | undefined): number {
  if (!value) return 0;
  const raw = parseFloat(value);
  if (!Number.isFinite(raw)) return 0;
  return Math.round(raw * 1_000_000 * 100) / 100;
}

function buildThinkingLevelMap(reasoning: Record<string, unknown> | undefined): Record<ThinkingLevel, string | null> | null {
  if (!reasoning) return null;
  const supportedEfforts = reasoning.supported_efforts;
  if (!Array.isArray(supportedEfforts)) return null;
  const map: Partial<Record<ThinkingLevel, string | null>> = {};
  for (const effort of supportedEfforts) {
    if (typeof effort !== "string") continue;
    const level = effort.toLowerCase() as ThinkingLevel;
    if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)) {
      map[level] = effort;
    }
  }
  // If no entries, return null
  if (Object.keys(map).length === 0) return null;
  return map as Record<ThinkingLevel, string | null>;
}

function compactifyModels(data: Array<Record<string, unknown>>): Record<string, CompactModelInfo> {
  const result: Record<string, CompactModelInfo> = {};
  for (const m of data) {
    const id = typeof m.id === "string" ? m.id : "";
    if (!id) continue;
    const pricing = m.pricing as Record<string, string> | undefined;
    const pi = parsePrice(pricing?.prompt);
    const po = parsePrice(pricing?.completion);
    const pr = parsePrice(pricing?.input_cache_read);
    const pw = parsePrice(pricing?.input_cache_write);
    const topProvider = m.top_provider as Record<string, unknown> | undefined;
    const supportedParams = m.supported_parameters as string[] | undefined;
    const reasoning = m.reasoning as Record<string, unknown> | undefined;
    const name = typeof m.name === "string" ? m.name : id;
    const contextLength = typeof m.context_length === "number" ? m.context_length : 0;
    const maxCompletionTokens =
      typeof topProvider?.max_completion_tokens === "number"
        ? topProvider.max_completion_tokens
        : typeof m.maxTokens === "number"
          ? m.maxTokens
          : 0;
    result[id] = {
      id,
      n: name,
      c: contextLength,
      m: maxCompletionTokens,
      pi,
      po,
      pr,
      pw,
      t: supportedParams?.includes("tools") ? 1 : 0,
      re: !!(reasoning || supportedParams?.includes("reasoning")) ? 1 : 0,
      tlm: buildThinkingLevelMap(reasoning),
    };
  }
  return result;
}

async function writeCache(cache: PricingCache): Promise<void> {
  if (!cacheFilePath || !vaultAdapter) return;
  try {
    await vaultAdapter.write(cacheFilePath, JSON.stringify(cache));
  } catch {
    // Silent failure — pricing is a nice-to-have
  }
}

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      window.setTimeout(() => reject(new Error("Timeout")), timeoutMs);
    }),
  ]);
}
