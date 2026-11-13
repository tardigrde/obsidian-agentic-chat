import type { Agent } from "@earendil-works/pi-agent-core";
import type { AgenticChatSettings } from "../settings-schema";
import type { AgentConversation } from "./conversation";
import type { AgentSessionLocalState } from "./session-local-state";
import { promptRunBlockReason } from "./turn-control";

export type PromptTurnRun = (agent: Agent) => Promise<void>;

/** Shared UX text for every stale-session guard on the prompt path. */
export const SESSION_CHANGED_MESSAGE =
  "The session changed while preparing this turn. Send the message again.";

export interface AgentPromptTurnRuntimeOptions {
  /** The live agent a turn runs on, refreshed against current settings before each turn. */
  conversation: Pick<AgentConversation, "requireAgent" | "refreshConfiguration">;
  /** Where a blocked, stale, or failed turn reports its error. */
  errors: Pick<AgentSessionLocalState, "clearError" | "setError" | "setErrorMessage">;
  getSettings: () => AgenticChatSettings;
  hasApiKey: () => boolean;
  getSessionCostUsd: () => number;
  maybeCompact: () => Promise<void>;
  /** Return a message when compaction left the transcript unusable. */
  afterCompaction?: () => string | undefined;
  /** Active session path + generation, sampled before turn preparation. */
  sessionToken?: () => string;
  /** Called once an accepted turn starts, after the synchronous in-flight guard. */
  onTurnStart?: () => void;
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

  async run(run: PromptTurnRun, expectedSessionToken?: string): Promise<void> {
    const blockReason = this.blockReason();
    if (blockReason) {
      this.options.errors.setErrorMessage(blockReason);
      this.options.notifyChange();
      return;
    }

    // Synchronous guard: `isStreaming` only flips once prompt() starts, so two
    // sends could both pass the pre-flight check and race into `agent.prompt()`.
    if (this.inFlight) {
      const message = "A turn is already starting. Wait for it to finish before sending another message.";
      this.options.errors.setErrorMessage(message);
      this.options.notifyChange();
      return;
    }
    this.inFlight = true;
    this.options.onTurnStart?.();
    const sessionToken = expectedSessionToken ?? this.options.sessionToken?.();
    try {
      if (
        expectedSessionToken !== undefined &&
        this.options.sessionToken !== undefined &&
        this.options.sessionToken() !== expectedSessionToken
      ) {
        this.sessionChanged();
        return;
      }
      await this.options.conversation.refreshConfiguration();
      await this.options.maybeCompact();
      if (sessionToken !== undefined && this.options.sessionToken?.() !== sessionToken) {
        this.sessionChanged();
        return;
      }
      const compactionError = this.options.afterCompaction?.();
      if (compactionError) {
        this.options.errors.setErrorMessage(compactionError);
        this.options.notifyChange();
        return;
      }
      try {
        this.options.errors.clearError();
        this.options.notifyChange();
        await run(this.options.conversation.requireAgent());
      } catch (error) {
        this.options.errors.setError(error);
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

  private sessionChanged(): void {
    this.options.errors.setErrorMessage(SESSION_CHANGED_MESSAGE);
    this.options.notifyChange();
  }

  private blockReason(): string | undefined {
    const settings = this.options.getSettings();
    return promptRunBlockReason({
      isStreaming: this.options.conversation.requireAgent().state.isStreaming,
      hasApiKey: this.options.hasApiKey(),
      provider: settings.provider,
      spendCapUsd: settings.notifications.costCapUsd,
      sessionCostUsd: this.options.getSessionCostUsd(),
    });
  }
}
