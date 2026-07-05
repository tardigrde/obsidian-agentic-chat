import type { Usage } from "@earendil-works/pi-ai";
import type { ToolBudgetSnapshot } from "../agent/tool-budget";
import { formatCost, formatUsage, shortModelLabel } from "./format";

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

export function folderButtonAriaLabel(scopeCount: number): string {
  return scopeCount > 0
    ? `Folders · ${scopeCount} working ${scopeCount === 1 ? "directory" : "directories"} granted`
    : "Folders: working directory or attach listing";
}

export function toolBudgetNotificationKey(toolBudget: ToolBudgetSnapshot): string | null {
  if (!toolBudget.active || toolBudget.droppedTools.length === 0) return null;
  return toolBudget.droppedTools.map((tool) => tool.name).join(",");
}
