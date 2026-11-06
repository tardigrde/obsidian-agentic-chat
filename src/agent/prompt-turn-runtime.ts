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
  /** Return a message when compaction left the transcript unusable. */
  afterCompaction?: () => string | undefined;
  /** Active session path + generation, sampled before turn preparation. */
  sessionToken?: () => string;
  /** Called once an accepted turn starts, after the synchronous in-flight guard. */
  onTurnStart?: () => void;
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
  private inFlight = false;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly options: AgentPromptTurnRuntimeOptions) {}

  /** True from the moment a turn is accepted until its run settles. */
  isInFlight(): boolean {
    return this.inFlight;
  }

  /** Resolve once no turn is starting or running. Used by internal continuations. */
  async waitForIdle(): Promise<void> {
    if (!this.inFlight) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  async run(run: PromptTurnRun): Promise<void> {
    const blockReason = this.blockReason();
    if (blockReason) {
      this.options.setErrorMessage(blockReason);
      this.options.notifyChange();
      return;
    }

    // Synchronous guard: `isStreaming` only flips once prompt() starts, so two
    // sends could both pass the pre-flight check and race into `agent.prompt()`.
    if (this.inFlight) {
      const message = "A turn is already starting. Wait for it to finish before sending another message.";
      this.options.setErrorMessage(message);
      this.options.notifyChange();
      return;
    }
    this.inFlight = true;
    this.options.onTurnStart?.();
    const sessionToken = this.options.sessionToken?.();
    try {
      await this.options.refreshConfiguration();
      await this.options.maybeCompact();
      if (sessionToken !== undefined && this.options.sessionToken?.() !== sessionToken) {
        this.options.setErrorMessage(
          "The session changed while preparing this turn. Send the message again.",
        );
        this.options.notifyChange();
        return;
      }
      const compactionError = this.options.afterCompaction?.();
      if (compactionError) {
        this.options.setErrorMessage(compactionError);
        this.options.notifyChange();
        return;
      }
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
    } finally {
      this.inFlight = false;
      for (const resolve of this.idleWaiters.splice(0)) resolve();
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
