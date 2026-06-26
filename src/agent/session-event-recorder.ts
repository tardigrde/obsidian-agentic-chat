import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { deriveAutoName, type ObsidianSessionManager } from "../session/session-manager";

/**
 * Persists agent transcript events into the active JSONL session. The pi Agent
 * emits each message as it ends and then re-emits the whole transcript at
 * `agent_end`, so this owns the WeakSet de-dupe needed to append each message
 * exactly once.
 */
export class AgentSessionEventRecorder {
  private readonly sessionManager: ObsidianSessionManager;
  private persisted = new WeakSet<object>();

  constructor(sessionManager: ObsidianSessionManager) {
    this.sessionManager = sessionManager;
  }

  /**
   * Mark messages already present in the session file, usually after load,
   * truncate, compaction, or any fresh agent replacement around persisted state.
   */
  markPersistedMessages(messages: AgentMessage[]): void {
    this.persisted = new WeakSet<object>();
    for (const message of messages) this.persisted.add(message as object);
  }

  async recordMessageEnd(message: AgentMessage): Promise<void> {
    await this.persistMessage(message);
  }

  async recordAgentEnd(messages: AgentMessage[]): Promise<void> {
    for (const message of messages) await this.persistMessage(message);
    await this.autoNameSession();
  }

  private async persistMessage(message: AgentMessage): Promise<void> {
    const key = message as object;
    if (this.persisted.has(key)) return;
    await this.sessionManager.appendMessage(message);
    this.persisted.add(key);
  }

  /** Name an as-yet-unnamed session after its first user prompt, once. */
  private async autoNameSession(): Promise<void> {
    if (!this.sessionManager.hasActiveSession()) return;
    const info = this.sessionManager.getActiveSessionInfo();
    if (info.name || info.messageCount === 0) return;
    const name = deriveAutoName(info.firstMessage);
    if (!name) return;
    await this.sessionManager.appendSessionName(name);
  }
}
