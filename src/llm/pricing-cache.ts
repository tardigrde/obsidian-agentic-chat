import { requestUrl, type App, type DataAdapter, type Plugin } from "obsidian";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { withTimeout } from "../utils/async";
import { parseModelsPayload, type ParsedModel } from "./model-catalog";

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
  im?: 0 | 1; // accepts image input (architecture.input_modalities)
}

/** Bumped when CompactModelInfo gains a field; an older cache file is refetched. */
const CACHE_VERSION = 2;

interface PricingCache {
  version?: number;
  fetchedAt: number;
  models: Record<string, CompactModelInfo>;
}

const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const DEFAULT_TIMEOUT_MS = 30_000;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Retry a failed catalog fetch after these delays, then wait for the next on-demand refetch (U4 #6). */
export const CATALOG_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000] as const;
/** An on-demand refetch (a model missing, or no image flag) runs at most this often. */
const ON_DEMAND_REFETCH_MS = 5 * 60_000;

let vaultAdapter: DataAdapter | null = null;
let cacheFilePath: string | null = null;
let inFlightPromise: Promise<PricingCache> | null = null;
let memoryCache: PricingCache | null = null;
let lastFetchError: string | null = null;
let lastFetchAttemptAt = 0;
let failedAttempts = 0;
let retryTimer: number | null = null;

/** What `/doctor` reports about the model catalog. */
export interface ModelCatalogStatus {
  /** When the catalog in memory was fetched; 0 when there is none. */
  fetchedAt: number;
  /** Catalog file from an older plugin release (no current `version`). */
  outdated: boolean;
  models: number;
  /** The last fetch error, until a fetch succeeds. */
  lastError: string | null;
  failedAttempts: number;
}

export function modelCatalogStatus(): ModelCatalogStatus {
  return {
    fetchedAt: memoryCache?.fetchedAt ?? 0,
    outdated: !!memoryCache && memoryCache.version !== CACHE_VERSION,
    models: memoryCache ? Object.keys(memoryCache.models).length : 0,
    lastError: lastFetchError,
    failedAttempts,
  };
}

export function initPricingCache(app: App, plugin: Plugin): void {
  vaultAdapter = app.vault.adapter;
  const pluginDir = plugin.manifest.dir ?? `${app.vault.configDir}/plugins/${plugin.manifest.id}`;
  cacheFilePath = `${pluginDir}/pricing-cache.json`;
  // Warm the in-memory cache and, when the file is missing or stale, kick off a
  // background network refresh so pricing is populated on a fresh install.
  void getCache();
}

/** Resolve full model info synchronously from the in-memory cache. */
export function resolveModelInfoSync(
  provider: "openrouter" | "ollama" | "openai-compatible",
  modelId: string,
): CompactModelInfo | undefined {
  if (provider === "ollama") return undefined;
  const cache = memoryCache;
  if (!cache) return undefined;
  const info = findInCache(cache, provider, modelId);
  // A model the catalog does not know, or knows without an image flag (a file
  // from an older release), refetches the catalog in the background.
  if (provider === "openrouter" && (!info || info.im === undefined)) requestCatalogRefresh();
  return info;
}

/**
 * Refetch the catalog now unless one is running or one ran in the last few
 * minutes. Used when a lookup misses; the result lands in memory and on disk.
 */
export function requestCatalogRefresh(): void {
  if (inFlightPromise || !vaultAdapter) return;
  if (Date.now() - lastFetchAttemptAt < ON_DEMAND_REFETCH_MS) return;
  void startFetch();
}

function startFetch(): Promise<PricingCache> {
  inFlightPromise ??= fetchAndStoreCache().finally(() => {
    inFlightPromise = null;
  });
  return inFlightPromise;
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

/** Test-only: seed the in-memory catalog cache without a network fetch. */
export function seedPricingCacheForTests(models: Record<string, CompactModelInfo>): void {
  memoryCache = { version: CACHE_VERSION, fetchedAt: Date.now(), models };
}

/** Test-only: clear the in-memory catalog cache back to the unknown state. */
export function clearPricingCacheForTests(): void {
  memoryCache = null;
  lastFetchError = null;
  lastFetchAttemptAt = 0;
  failedAttempts = 0;
  if (retryTimer) window.clearTimeout(retryTimer);
  retryTimer = null;
  inFlightPromise = null;
}

/** Test-only: load the catalog from a file as a fresh plugin start would. */
export async function loadPricingCacheFromFileForTests(adapter: DataAdapter, path: string): Promise<void> {
  clearPricingCacheForTests();
  vaultAdapter = adapter;
  cacheFilePath = path;
  await getCache();
}

/** Test-only: settle a running fetch. */
export async function waitForCatalogFetchForTests(): Promise<void> {
  await inFlightPromise;
}

function findInCache(cache: PricingCache, provider: string, modelId: string): CompactModelInfo | undefined {
  // Exact match
  if (cache.models[modelId]) return cache.models[modelId];

  // For openai-compatible, try suffix match (e.g. "gpt-4o" → "openai/gpt-4o").
  // Only trust an unambiguous match: if several providers share the suffix we
  // can't tell which price applies, so fall through to unknown rather than
  // guessing an arbitrary insertion-order-dependent entry.
  if (provider === "openai-compatible" && !modelId.includes("/")) {
    const matches = Object.keys(cache.models).filter((key) => key.slice(key.lastIndexOf("/") + 1) === modelId);
    if (matches.length === 1) return cache.models[matches[0]];
  }

  return undefined;
}

async function getCache(): Promise<PricingCache> {
  // Ensure memory cache is loaded first
  await loadCacheIntoMemory();

  if (memoryCache && memoryCache.version === CACHE_VERSION && Date.now() - memoryCache.fetchedAt < CACHE_TTL_MS) {
    return memoryCache;
  }

  // Stale, missing, or from an older release: refresh in the background.
  if (!retryTimer) void startFetch();

  // Return stale data while refreshing, or empty if none exists
  return memoryCache ?? { fetchedAt: 0, models: {} };
}

function isPricingCache(value: unknown): value is PricingCache {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.fetchedAt === "number" && typeof candidate.models === "object" && candidate.models !== null;
}

async function loadCacheIntoMemory(): Promise<void> {
  if (memoryCache) return;
  if (!cacheFilePath || !vaultAdapter) return;
  try {
    const raw = await vaultAdapter.read(cacheFilePath);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!isPricingCache(parsed)) return;
    memoryCache = parsed;
  } catch {
    // File missing or corrupt — will be fetched later
  }
}

async function fetchAndStoreCache(): Promise<PricingCache> {
  lastFetchAttemptAt = Date.now();
  try {
    const response = await withTimeout(
      requestUrl({ url: OPENROUTER_MODELS_URL, throw: false }),
      DEFAULT_TIMEOUT_MS,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`OpenRouter models API returned ${response.status}`);
    }
    const models = compactifyModels(parseModelsPayload(response.json) ?? []);
    const cache: PricingCache = { version: CACHE_VERSION, fetchedAt: Date.now(), models };
    await writeCache(cache);
    memoryCache = cache;
    lastFetchError = null;
    failedAttempts = 0;
    return cache;
  } catch (error) {
    console.warn("Agentic Chat: failed to refresh OpenRouter pricing cache.", error);
    lastFetchError = error instanceof Error ? error.message : String(error);
    scheduleRetry();
    // On failure, keep stale memory cache if available
    if (memoryCache) return memoryCache;
    return { fetchedAt: 0, models: {} };
  }
}

/** A failed fetch retries with backoff (30 s, 2 min, 10 min), then waits for an on-demand refetch. */
function scheduleRetry(): void {
  const delay = CATALOG_RETRY_DELAYS_MS[failedAttempts];
  failedAttempts += 1;
  if (delay === undefined || retryTimer) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void startFetch();
  }, delay);
}

function compactifyModels(models: ParsedModel[]): Record<string, CompactModelInfo> {
  const result: Record<string, CompactModelInfo> = {};
  for (const model of models) {
    if (!model.id) continue;
    result[model.id] = {
      id: model.id,
      n: model.name,
      c: model.contextLength ?? 0,
      m: model.maxCompletionTokens,
      pi: model.pricing.input,
      po: model.pricing.output,
      pr: model.pricing.cacheRead,
      pw: model.pricing.cacheWrite,
      t: model.supportsTools ? 1 : 0,
      re: model.reasoningMetadata ? 1 : 0,
      tlm: model.thinkingLevelMap,
      im: model.inputModalities.includes("image") ? 1 : 0,
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

