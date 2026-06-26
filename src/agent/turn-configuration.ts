import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import { activeModelConfig, activeModelId } from "../settings";
import { buildModel, supportedThinkingLevels, type ModelConfig } from "../llm/models";
import {
  normalizeModelOverride,
  resolveModelConfigForTurn,
  resolveThinkingLevelForTurn,
  visibleModelOverride,
} from "./turn-control";

export interface AgentTurnConfigurationOptions {
  getSettings: () => AgenticChatSettings;
  resolveSupportedThinkingLevels?: (config: ModelConfig) => ThinkingLevel[];
}

/**
 * Owns per-turn model/thinking overrides and the small cache behind the effort
 * picker. AgentService decides when to push these resolved values into the live
 * pi Agent; this class only tracks and resolves the next-turn configuration.
 */
export class AgentTurnConfiguration {
  private readonly getSettings: () => AgenticChatSettings;
  private readonly resolveSupportedThinkingLevels: (config: ModelConfig) => ThinkingLevel[];
  private modelOverride: string | null = null;
  private thinkingOverride: ThinkingLevel | null = null;
  private cachedLevels: { modelId: string; levels: ThinkingLevel[] } | null = null;

  constructor(options: AgentTurnConfigurationOptions) {
    this.getSettings = options.getSettings;
    this.resolveSupportedThinkingLevels =
      options.resolveSupportedThinkingLevels ?? ((config) => supportedThinkingLevels(buildModel(config)));
  }

  setModelOverride(modelId: string | null): void {
    this.modelOverride = normalizeModelOverride(modelId);
  }

  getModelOverride(): string | null {
    return visibleModelOverride(this.getSettings().provider, this.modelOverride);
  }

  getActiveModelId(): string {
    return this.getModelOverride() ?? activeModelId(this.getSettings());
  }

  setThinkingOverride(level: ThinkingLevel | null): void {
    this.thinkingOverride = level;
  }

  getThinkingOverride(): ThinkingLevel | null {
    return this.thinkingOverride;
  }

  getActiveThinkingLevel(): ThinkingLevel {
    return this.thinkingLevelForTurn(this.getSettings());
  }

  getActiveThinkingLevels(): ThinkingLevel[] {
    const modelId = this.getActiveModelId();
    if (this.cachedLevels?.modelId === modelId) return this.cachedLevels.levels;
    const levels = this.resolveSupportedThinkingLevels(this.modelConfigForTurn(this.getSettings()));
    this.cachedLevels = { modelId, levels };
    return levels;
  }

  modelConfigForTurn(settings: AgenticChatSettings = this.getSettings()): ModelConfig {
    return resolveModelConfigForTurn(activeModelConfig(settings), this.modelOverride);
  }

  buildModelForTurn(settings: AgenticChatSettings = this.getSettings()): Model<"openai-completions"> {
    return buildModel(this.modelConfigForTurn(settings));
  }

  thinkingLevelForTurn(settings: AgenticChatSettings = this.getSettings()): ThinkingLevel {
    return resolveThinkingLevelForTurn(settings.thinkingLevel, this.thinkingOverride, this.getActiveThinkingLevels());
  }

  consumeOverrides(): void {
    this.modelOverride = null;
    this.thinkingOverride = null;
  }
}
