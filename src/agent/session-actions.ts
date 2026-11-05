import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionInfo } from "../session/session-manager";
import type { ActiveSessionSnapshot } from "./active-session-runtime";
import type { ActivateSessionOptions } from "./session-activation";
import { conversationMessages } from "./conversation-messages";
import { AgentSessionSwapQueue, type AgentSessionSwapState } from "./session-swap-queue";

export interface AgentSessionActionsRuntime {
  readonly activePath: string | null;
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

  constructor(private readonly options: AgentSessionActionsOptions) {}

  getSwapState(): AgentSessionSwapState {
    return this.sessionSwaps.state;
  }

  /** Wait for any in-flight swap; reject when the last swap failed. */
  async waitForLive(): Promise<void> {
    const state = await this.sessionSwaps.waitForSettled();
    if (state === "failed") {
      throw new Error("The last session swap failed. Load or create a session to recover.");
    }
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
      await this.options.activation.prepareResources();
      setPhase("loading");
      const { messages } = await this.options.sessions.create();
      setPhase("activating");
      this.options.activation.detachAgent();
      await this.activateSession(messages);
    });
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.options.sessions.list();
  }

  async loadSession(path: string): Promise<void> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      // Reload before detaching: a failed reload must leave the previous agent
      // and its session-local state intact.
      await this.options.activation.prepareResources();
      setPhase("loading");
      const { messages } = await this.options.sessions.load(path);
      setPhase("activating");
      this.options.activation.detachAgent();
      await this.activateSession(messages);
    });
  }

  async deleteSession(path: string): Promise<void> {
    const active = this.options.sessions.activePath;
    await this.options.sessions.delete(path);
    await this.options.afterDelete?.();
    if (active === path) await this.newSession();
    else this.options.notifyChange();
  }

  async clearSessions(): Promise<number> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      const sessions = await this.options.sessions.list();
      if (sessions.length === 0) {
        this.options.notifyChange();
        return 0;
      }
      await this.options.activation.prepareResources();
      setPhase("loading");
      for (const session of sessions) await this.options.sessions.delete(session.path);
      await this.options.afterDelete?.();
      const { messages } = await this.options.sessions.create();
      setPhase("activating");
      this.options.activation.detachAgent();
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
    const agent = this.options.activation.currentAgent;
    if (!agent || agent.state.isStreaming) return;
    // `index` addresses the conversation transcript the UI renders, which excludes
    // pi's system-context message. Rewind the persisted conversation to that
    // index; the replacement agent re-seeds its own system message from the
    // current system prompt.
    const conversation = conversationMessages(agent.state.messages).slice(0, Math.max(0, index));
    const snapshot = await this.options.sessions.rewriteMessages(conversation);
    await this.options.activation.activate(snapshot.messages, { reloadResources: false });
    this.options.notifyChange();
  }

  private async loadIntoNewAgent(
    setPhase: (phase: "loading" | "activating") => void,
    load: () => Promise<ActiveSessionSnapshot>,
  ): Promise<void> {
    await this.options.activation.prepareResources();
    setPhase("loading");
    const { messages } = await load();
    setPhase("activating");
    this.options.activation.detachAgent();
    await this.activateSession(messages);
  }

  private async activateSession(messages: AgentMessage[]): Promise<void> {
    // Resources were reloaded before detaching on the swap path.
    await this.options.activation.activate(messages, { reloadResources: false });
    this.options.notifyChange();
  }
}
