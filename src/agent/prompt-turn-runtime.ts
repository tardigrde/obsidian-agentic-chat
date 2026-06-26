import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgenticChatSettings } from "../settings";
import { promptRunBlockReason } from "./turn-control";

export type PromptTurnRun = (agent: Agent) => Promise<void>;

export interface AgentPromptTurnRuntimeOptions {
  requireAgent: () => Agent;
  getSettings: () => AgenticChatSettings;
  hasApiKey: () => boolean;
  getSessionCostUsd: () => number;
  refreshConfiguration: () => Promise<void>;
  maybeCompact: () => Promise<void>;
  clearError: () => void;
  setError: (error: unknown) => void;
  setErrorMessage: (message: string) => void;
  consumeOverrides: () => void;
  notifyChange: () => void;
}

/**
 * Owns one prompt turn's control flow. AgentService stays responsible for the
 * public API; this class owns the sequence around a turn.
 */
export class AgentPromptTurnRuntime {
  constructor(private readonly options: AgentPromptTurnRuntimeOptions) {}

  async run(run: PromptTurnRun): Promise<void> {
    const blockReason = this.blockReason();
    if (blockReason) {
      this.options.setErrorMessage(blockReason);
      this.options.notifyChange();
      return;
    }

    await this.options.refreshConfiguration();
    await this.options.maybeCompact();
    try {
      this.options.clearError();
      this.options.notifyChange();
      await run(this.options.requireAgent());
    } catch (error) {
      this.options.setError(error);
    } finally {
      // One-shot model/thinking overrides are consumed by the attempted turn.
      this.options.consumeOverrides();
      this.options.notifyChange();
    }
  }

  private blockReason(): string | undefined {
    const settings = this.options.getSettings();
    return promptRunBlockReason({
      isStreaming: this.options.requireAgent().state.isStreaming,
      hasApiKey: this.options.hasApiKey(),
      provider: settings.provider,
      spendCapUsd: settings.notifications.costCapUsd,
      sessionCostUsd: this.options.getSessionCostUsd(),
    });
  }
}
