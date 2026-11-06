import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionInfo } from "../session/session-manager";
import type { ActiveSessionSnapshot } from "./active-session-runtime";
import type { ActivateSessionOptions } from "./session-activation";
import { conversationMessages } from "./conversation-messages";
import { AgentSessionSwapQueue, type AgentSessionSwapState } from "./session-swap-queue";

export interface AgentSessionActionsRuntime {
  readonly activePath: string | null;
  readonly generation: number;
  continueRecent(): Promise<ActiveSessionSnapshot>;
  create(): Promise<ActiveSessionSnapshot>;
  load(path: string): Promise<ActiveSessionSnapshot>;
  list(): Promise<SessionInfo[]>;
  delete(path: string): Promise<void>;
  rename(path: string, name: string): Promise<void>;
  rewriteMessages(messages: AgentMessage[]): Promise<ActiveSessionSnapshot>;
  refreshInfoIfActive(): SessionInfo | undefined;
}

export interface AgentSessionActivationRuntime {
  readonly currentAgent: Agent | null;
  prepareResources(): Promise<void>;
  detachAgent(): void;
  activate(messages: AgentMessage[], options?: ActivateSessionOptions): Promise<void>;
}

export interface AgentSessionActionsOptions {
  sessions: AgentSessionActionsRuntime;
  activation: AgentSessionActivationRuntime;
  notifyChange: () => void;
  afterDelete?: () => void | Promise<void>;
}

export class AgentSessionActions {
  private readonly sessionSwaps = new AgentSessionSwapQueue();
  /** Increments only for explicit session-changing operations, not reloads. */
  private sessionEpoch = 0;

  constructor(private readonly options: AgentSessionActionsOptions) {}

  getSwapState(): AgentSessionSwapState {
    return this.sessionSwaps.state;
  }

  /** Path + explicit epoch of the session a turn started against. */
  getSessionToken(): string {
    return `${this.options.sessions.activePath ?? ""}:${this.sessionEpoch}`;
  }

  /**
   * Wait for any in-flight swap. A failed swap is not sticky: when no agent
   * survived, the caller falls through to {@link ensureSessionAgent}, which
   * retries the recent session on the next send or session action.
   */
  async waitForLive(): Promise<void> {
    await this.sessionSwaps.waitForSettled();
  }

  /** Startup path: continue the recent session only when no agent is live. */
  async ensureSessionAgent(): Promise<void> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      if (this.options.activation.currentAgent) return;
      await this.loadIntoNewAgent(setPhase, () => this.options.sessions.continueRecent());
    });
  }

  async continueRecentSession(): Promise<void> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      await this.loadIntoNewAgent(setPhase, () => this.options.sessions.continueRecent());
    });
  }

  async newSession(): Promise<void> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      this.sessionEpoch += 1;
      const previousPath = this.options.sessions.activePath;
      await this.options.activation.prepareResources();
      // Stop the old agent before the session pointer moves, so a late
      // message_end/agent_end cannot land in the new file.
      this.options.activation.detachAgent();
      setPhase("loading");
      let messages: AgentMessage[];
      try {
        ({ messages } = await this.options.sessions.create());
      } catch (error) {
        if (await this.restorePreviousSession(previousPath, setPhase)) {
          throw new Error("Could not create a new session; the previous session is still open.", { cause: error });
        }
        throw error;
      }
      setPhase("activating");
      await this.activateSession(messages);
    });
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.options.sessions.list();
  }

  async loadSession(path: string): Promise<void> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      this.sessionEpoch += 1;
      const previousPath = this.options.sessions.activePath;
      // Reload before detaching: a failed reload must leave the previous agent
      // and its session-local state intact.
      await this.options.activation.prepareResources();
      this.options.activation.detachAgent();
      setPhase("loading");
      let messages: AgentMessage[];
      try {
        ({ messages } = await this.options.sessions.load(path));
      } catch (error) {
        if (await this.restorePreviousSession(previousPath, setPhase)) {
          throw new Error(`Could not load ${path}; the previous session is still open.`, { cause: error });
        }
        throw error;
      }
      setPhase("activating");
      await this.activateSession(messages);
    });
  }

  async deleteSession(path: string): Promise<void> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      const active = this.options.sessions.activePath;
      if (active !== path) {
        await this.options.sessions.delete(path);
        await this.options.afterDelete?.();
        this.options.notifyChange();
        return;
      }
      this.sessionEpoch += 1;
      await this.options.activation.prepareResources();
      this.options.activation.detachAgent();
      setPhase("loading");
      await this.options.sessions.delete(path);
      await this.options.afterDelete?.();
      const { messages } = await this.options.sessions.create();
      setPhase("activating");
      await this.activateSession(messages);
    });
  }

  async clearSessions(): Promise<number> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      const sessions = await this.options.sessions.list();
      if (sessions.length === 0) {
        this.options.notifyChange();
        return 0;
      }
      this.sessionEpoch += 1;
      await this.options.activation.prepareResources();
      this.options.activation.detachAgent();
      setPhase("loading");
      for (const session of sessions) await this.options.sessions.delete(session.path);
      await this.options.afterDelete?.();
      const { messages } = await this.options.sessions.create();
      setPhase("activating");
      await this.activateSession(messages);
      return sessions.length;
    });
  }

  async renameSession(path: string, name: string): Promise<void> {
    await this.options.sessions.rename(path, name);
    this.options.sessions.refreshInfoIfActive();
    this.options.notifyChange();
  }

  async truncateMessages(index: number): Promise<void> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      const agent = this.options.activation.currentAgent;
      if (!agent || agent.state.isStreaming) return;
      this.sessionEpoch += 1;
      // `index` addresses the conversation transcript the UI renders, which excludes
      // pi's system-context message. Rewind the persisted conversation to that
      // index; the replacement agent re-seeds its own system message from the
      // current system prompt.
      const conversation = conversationMessages(agent.state.messages).slice(0, Math.max(0, index));
      await this.options.activation.prepareResources();
      setPhase("loading");
      const snapshot = await this.options.sessions.rewriteMessages(conversation);
      setPhase("activating");
      this.options.activation.detachAgent();
      await this.options.activation.activate(snapshot.messages, { reloadResources: false });
      this.options.notifyChange();
    });
  }

  /**
   * Reload the session that was active before a failed swap. Returns false
   * when there was no previous session or reloading it also fails; the caller
   * then leaves recovery to {@link ensureSessionAgent}.
   */
  private async restorePreviousSession(
    previousPath: string | null,
    setPhase: (phase: "loading" | "activating") => void,
  ): Promise<boolean> {
    if (!previousPath) return false;
    try {
      const { messages } = await this.options.sessions.load(previousPath);
      setPhase("activating");
      await this.activateSession(messages);
      return true;
    } catch {
      return false;
    }
  }

  private async loadIntoNewAgent(
    setPhase: (phase: "loading" | "activating") => void,
    load: () => Promise<ActiveSessionSnapshot>,
  ): Promise<void> {
    await this.options.activation.prepareResources();
    this.options.activation.detachAgent();
    setPhase("loading");
    const { messages } = await load();
    setPhase("activating");
    await this.activateSession(messages);
  }

  private async activateSession(messages: AgentMessage[]): Promise<void> {
    // Resources were reloaded before detaching on the swap path.
    await this.options.activation.activate(messages, { reloadResources: false });
    this.options.notifyChange();
  }
}
