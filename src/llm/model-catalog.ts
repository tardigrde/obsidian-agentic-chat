import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Normalized model fields from one OpenRouter-style `/models` payload. */
export interface ParsedModel {
  id: string;
  name: string;
  contextLength: number | null;
  maxCompletionTokens: number;
  pricing: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  supportsTools: boolean;
  /** Catalog feature flag used by the model browser. */
  supportsReasoning: boolean;
  /** Pricing-cache heuristic: reasoning metadata or an explicit parameter. */
  reasoningMetadata: boolean;
  thinkingLevelMap: Record<ThinkingLevel, string | null> | null;
}

interface ModelListItem {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  supports_reasoning?: boolean;
  reasoning?: { supported_efforts?: string[] | null } | null;
  pricing?: Record<string, string>;
  top_provider?: Record<string, unknown>;
  maxTokens?: number;
}

/**
 * Parse one `/models` response body. Returns `null` when the body itself is
 * malformed; returns `[]` when it has no model list. Both callers treat `null`
 * the same way they treated a failed shape check before this helper existed.
 */
export function parseModelsPayload(data: unknown): ParsedModel[] | null {
  if (typeof data !== "object" || data === null) return null;
  if (!("data" in data) || data.data === undefined) return [];
  const rows = data.data;
  if (!Array.isArray(rows) || !rows.every(isModelListItem)) return null;
  return rows.map(parseModel);
}

function isModelListItem(value: unknown): value is ModelListItem {
  if (typeof value !== "object" || value === null) return false;
  const model = value as Record<string, unknown>;
  return (
    typeof model.id === "string" &&
    (!("name" in model) || model.name === undefined || typeof model.name === "string") &&
    (!("context_length" in model) || model.context_length === undefined || typeof model.context_length === "number") &&
    (!("supported_parameters" in model) ||
      model.supported_parameters === undefined ||
      (Array.isArray(model.supported_parameters) &&
        model.supported_parameters.every((parameter: unknown) => typeof parameter === "string"))) &&
    (!("supports_reasoning" in model) ||
      model.supports_reasoning === undefined ||
      typeof model.supports_reasoning === "boolean") &&
    (!("reasoning" in model) || model.reasoning === undefined || typeof model.reasoning === "object") &&
    (!("pricing" in model) || model.pricing === undefined || typeof model.pricing === "object") &&
    (!("top_provider" in model) || model.top_provider === undefined || typeof model.top_provider === "object") &&
    (!("maxTokens" in model) || model.maxTokens === undefined || typeof model.maxTokens === "number")
  );
}

function parseModel(model: ModelListItem): ParsedModel {
  const id = model.id;
  const supportedParameters = model.supported_parameters ?? [];
  const reasoning = model.reasoning && typeof model.reasoning === "object" ? model.reasoning : undefined;
  return {
    id,
    name: typeof model.name === "string" ? model.name : id,
    contextLength: typeof model.context_length === "number" ? model.context_length : null,
    maxCompletionTokens: maxCompletionTokens(model),
    pricing: {
      input: parsePrice(model.pricing?.prompt),
      output: parsePrice(model.pricing?.completion),
      cacheRead: parsePrice(model.pricing?.input_cache_read),
      cacheWrite: parsePrice(model.pricing?.input_cache_write),
    },
    supportsTools: supportedParameters.includes("tools"),
    supportsReasoning: modelSupportsReasoning(model),
    reasoningMetadata: Boolean(reasoning) || supportedParameters.includes("reasoning"),
    thinkingLevelMap: buildThinkingLevelMap(reasoning),
  };
}

function maxCompletionTokens(model: ModelListItem): number {
  if (typeof model.top_provider?.max_completion_tokens === "number") {
    return model.top_provider.max_completion_tokens;
  }
  return typeof model.maxTokens === "number" ? model.maxTokens : 0;
}

function modelSupportsReasoning(model: ModelListItem): boolean {
  if (typeof model.supports_reasoning === "boolean") return model.supports_reasoning;
  if (model.reasoning && typeof model.reasoning === "object") return true;
  return (model.supported_parameters ?? []).includes("reasoning");
}

function parsePrice(value: string | undefined): number {
  if (!value) return 0;
  const raw = parseFloat(value);
  if (!Number.isFinite(raw)) return 0;
  return Math.round(raw * 1_000_000 * 100) / 100;
}

function buildThinkingLevelMap(
  reasoning: Record<string, unknown> | undefined,
): Record<ThinkingLevel, string | null> | null {
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
  if (Object.keys(map).length === 0) return null;
  return map as Record<ThinkingLevel, string | null>;
}
