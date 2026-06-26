import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionInfo } from "../session/session-manager";
import type { ActiveSessionSnapshot } from "./active-session-runtime";
import type { ActivateSessionOptions } from "./session-activation";
import { AgentSessionSwapQueue } from "./session-swap-queue";

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
  detachAgent(): void;
  activate(messages: AgentMessage[], options?: ActivateSessionOptions): Promise<void>;
}

export interface AgentSessionActionsOptions {
  sessions: AgentSessionActionsRuntime;
  activation: AgentSessionActivationRuntime;
  notifyChange: () => void;
}

export class AgentSessionActions {
  private readonly sessionSwaps = new AgentSessionSwapQueue();

  constructor(private readonly options: AgentSessionActionsOptions) {}

  async continueRecentSession(): Promise<void> {
    const { messages } = await this.options.sessions.continueRecent();
    await this.activateSession(messages);
  }

  async newSession(): Promise<void> {
    return this.sessionSwaps.enqueue(async () => {
      this.options.activation.detachAgent();
      const { messages } = await this.options.sessions.create();
      await this.activateSession(messages);
    });
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.options.sessions.list();
  }

  async loadSession(path: string): Promise<void> {
    return this.sessionSwaps.enqueue(async () => {
      this.options.activation.detachAgent();
      const { messages } = await this.options.sessions.load(path);
      await this.activateSession(messages);
    });
  }

  async deleteSession(path: string): Promise<void> {
    const active = this.options.sessions.activePath;
    await this.options.sessions.delete(path);
    if (active === path) await this.newSession();
    else this.options.notifyChange();
  }

  async renameSession(path: string, name: string): Promise<void> {
    await this.options.sessions.rename(path, name);
    this.options.sessions.refreshInfoIfActive();
    this.options.notifyChange();
  }

  async truncateMessages(index: number): Promise<void> {
    const agent = this.options.activation.currentAgent;
    if (!agent || agent.state.isStreaming) return;
    const messages = agent.state.messages.slice(0, Math.max(0, index));
    const snapshot = await this.options.sessions.rewriteMessages(messages);
    await this.options.activation.activate(snapshot.messages, { reloadResources: false });
    this.options.notifyChange();
  }

  private async activateSession(messages: AgentMessage[]): Promise<void> {
    await this.options.activation.activate(messages);
    this.options.notifyChange();
  }
}
