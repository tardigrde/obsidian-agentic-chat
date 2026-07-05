import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, type ModelConfig, type ProviderId } from "../llm/models";

export type TurnSteeringMode = "steer" | "follow-up" | "redirect";

export interface PromptRunPreflight {
  isStreaming: boolean;
  hasApiKey: boolean;
  provider: ProviderId;
  spendCapUsd: number;
  sessionCostUsd: number;
}

export interface SpendCapEnforcementInput {
  isStreaming: boolean;
  spendCapUsd: number;
  sessionCostUsd: number;
}

export function promptRunBlockReason(input: PromptRunPreflight): string | undefined {
  if (input.isStreaming) return "The agent is already responding.";
  if (!input.hasApiKey) return `Add a ${input.provider} API key in plugin settings before sending a prompt.`;
  if (input.spendCapUsd > 0 && input.sessionCostUsd >= input.spendCapUsd) {
    return (
      `Spend cap of $${input.spendCapUsd.toFixed(2)} reached for this conversation. ` +
      "Raise it in settings or start a new conversation."
    );
  }
  return undefined;
}

export function spendCapAbortReason(input: SpendCapEnforcementInput): string | undefined {
  if (input.spendCapUsd <= 0) return undefined;
  if (!input.isStreaming) return undefined;
  if (input.sessionCostUsd < input.spendCapUsd) return undefined;
  return `Spend cap of $${input.spendCapUsd.toFixed(2)} reached — stopped this turn.`;
}

export function normalizeSteeringText(text: string): string | null {
  return text.trim() || null;
}

export function steeringStatus(mode: TurnSteeringMode): string {
  switch (mode) {
    case "follow-up":
      return "Queued as a follow-up.";
    case "redirect":
      return "Redirecting the active turn.";
    case "steer":
      return "Queued for the active turn.";
  }
}

export function normalizeModelOverride(modelId: string | null): string | null {
  return modelId?.trim() || null;
}

export function visibleModelOverride(provider: ProviderId, modelOverride: string | null): string | null {
  return provider === "openrouter" || provider === "openai-compatible" ? modelOverride : null;
}

export function resolveModelConfigForTurn(config: ModelConfig, modelOverride: string | null): ModelConfig {
  if ((config.provider === "openrouter" || config.provider === "openai-compatible") && modelOverride) {
    return { ...config, modelId: modelOverride };
  }
  return config;
}

export function resolveThinkingLevelForTurn(
  defaultLevel: ThinkingLevel,
  override: ThinkingLevel | null,
  supportedLevels: ThinkingLevel[],
): ThinkingLevel {
  return clampThinkingLevel(override ?? defaultLevel, supportedLevels);
}
