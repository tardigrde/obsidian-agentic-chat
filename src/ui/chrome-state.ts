import { shortModelLabel } from "./format";

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

