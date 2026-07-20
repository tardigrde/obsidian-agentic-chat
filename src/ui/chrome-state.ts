import type { Usage } from "@earendil-works/pi-ai";
import type { ToolBudgetSnapshot } from "../agent/tool-budget";
import { cacheHitPercent, formatCost, formatTokenInteger, formatUsage, shortModelLabel } from "./format";

export interface ModelPillState {
  providerLabel: string;
  fullModel: string;
  shortModel: string;
  title: string;
  isOverride: boolean;
}

export function modelProviderLabel(provider: string): string {
  if (provider === "ollama") return "Ollama";
  if (provider === "openai-compatible") return "OpenAI-compatible";
  return "OpenRouter";
}

export function buildModelPillState(input: {
  provider: string;
  activeModelId: string;
  overrideModelId?: string | null;
}): ModelPillState {
  const isOverride = !!input.overrideModelId;
  const providerLabel = isOverride ? "next only" : modelProviderLabel(input.provider);
  const fullModel = input.overrideModelId ?? input.activeModelId;
  return {
    providerLabel,
    fullModel,
    shortModel: shortModelLabel(fullModel),
    title: `${providerLabel} · ${fullModel}`,
    isOverride,
  };
}

export function formatChromeUsageText(usage: Usage, nextEstimateUsd?: number): string {
  const parts: string[] = [];
  if (usage.totalTokens > 0) parts.push(formatUsage(usage));
  if (nextEstimateUsd !== undefined && nextEstimateUsd > 0) parts.push(`next ~${formatCost(nextEstimateUsd)}`);
  return parts.join(" · ");
}

/** Color tone for a cache-hit percentage: red under 50%, amber under 75%, green at/above. */
export function cacheHitTone(hit: number): "is-low" | "is-mid" | "is-high" {
  if (hit < 50) return "is-low";
  if (hit < 75) return "is-mid";
  return "is-high";
}

export interface UsageChromePart {
  text: string;
  /** Space-separated class names (e.g. the cache color tone). */
  cls?: string;
  /** Tooltip (used for the next-cost projection). */
  title?: string;
}

/**
 * Structured bottom-usage line parts (tokens · cache% [colored] · cost · next ~$X
 * [tooltip]), so the view can render each piece as its own styled span instead of
 * one opaque string. Returns [] when there is nothing to show.
 */
export function buildUsageChromeParts(usage: Usage, nextEstimateUsd?: number): UsageChromePart[] {
  const parts: UsageChromePart[] = [];
  if (usage.totalTokens > 0) {
    parts.push({ text: `${formatTokenInteger(usage.totalTokens)} tokens` });
    const hit = cacheHitPercent(usage);
    if (hit !== null) parts.push({ text: `${hit}% cache`, cls: `agentic-chat-cache ${cacheHitTone(hit)}` });
    const cost = usage.cost?.total;
    if (typeof cost === "number" && cost > 0) parts.push({ text: formatCost(cost) });
  }
  if (nextEstimateUsd !== undefined && nextEstimateUsd > 0) {
    parts.push({
      text: `next ~${formatCost(nextEstimateUsd)}`,
      cls: "agentic-chat-next-cost",
      title: "Projected cost of the next request (priced models only).",
    });
  }
  return parts;
}

export function folderButtonAriaLabel(scopeCount: number): string {
  if (scopeCount === 0) return "Folders: working directory or attach listing";
  const noun = scopeCount === 1 ? "directory" : "directories";
  return `Folders · ${scopeCount} working ${noun} granted`;
}

export function toolBudgetNotificationKey(toolBudget: ToolBudgetSnapshot): string | null {
  if (!toolBudget.active || toolBudget.droppedTools.length === 0) return null;
  return toolBudget.droppedTools.map((tool) => tool.name).join(",");
}
