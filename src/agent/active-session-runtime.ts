import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type LoadSessionOptions,
  type ObsidianSessionManager,
  type SessionDefaults,
  type SessionInfo,
} from "../session/session-manager";

export interface ActiveSessionSnapshot {
  info: SessionInfo;
  messages: AgentMessage[];
}

export class AgentActiveSessionRuntime {
  private sessionInfo: SessionInfo | undefined;

  constructor(
    private readonly sessionManager: ObsidianSessionManager,
    private readonly getDefaults: () => SessionDefaults,
  ) {}

  get info(): SessionInfo | undefined {
    return this.sessionInfo;
  }

  get activePath(): string | null {
    return this.sessionManager.getActiveSessionPath();
  }

  get generation(): number {
    return this.sessionManager.getActiveSessionGeneration();
  }

  async continueRecent(): Promise<ActiveSessionSnapshot> {
    return this.snapshot(await this.sessionManager.continueRecentSession(this.getDefaults()));
  }

  async create(): Promise<ActiveSessionSnapshot> {
    return this.snapshot(await this.sessionManager.createSession(this.getDefaults()));
  }

  async load(path: string, options?: LoadSessionOptions): Promise<ActiveSessionSnapshot> {
    return this.snapshot(await this.sessionManager.loadSession(path, options));
  }

  async rewriteMessages(
    messages: AgentMessage[],
    options: { expectedPath?: string | null; expectedGeneration?: number } = {},
  ): Promise<ActiveSessionSnapshot> {
    await this.sessionManager.rewriteMessages(messages, options);
    return this.snapshot(this.sessionManager.getActiveSessionInfo());
  }

  async ensureConfiguration(): Promise<SessionInfo> {
    await this.sessionManager.ensureConfiguration(this.getDefaults());
    return this.refreshInfo();
  }

  list(): Promise<SessionInfo[]> {
    return this.sessionManager.listSessions();
  }

  async delete(path: string): Promise<void> {
    const activePath = this.activePath;
    await this.sessionManager.deleteSession(path);
    if (activePath === path) this.sessionInfo = undefined;
  }

  rename(path: string, name: string): Promise<void> {
    return this.sessionManager.renameSession(path, name);
  }

  refreshInfoIfActive(): SessionInfo | undefined {
    if (!this.sessionManager.hasActiveSession()) {
      this.sessionInfo = undefined;
      return undefined;
    }
    return this.refreshInfo();
  }

  private refreshInfo(): SessionInfo {
    this.sessionInfo = this.sessionManager.getActiveSessionInfo();
    return this.sessionInfo;
  }

  private snapshot(info: SessionInfo): ActiveSessionSnapshot {
    this.sessionInfo = info;
    return {
      info,
      messages: this.sessionManager.buildSessionContext().messages,
    };
  }
}
