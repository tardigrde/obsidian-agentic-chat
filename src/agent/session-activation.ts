import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";

interface ParentAgentRuntime {
  readonly current: Agent | null;
  detach(): void;
  replace(messages: AgentMessage[]): Agent | null;
}

interface SessionPersistenceState {
  markPersistedMessages(messages: AgentMessage[]): void;
}

interface SessionVolatileState {
  reset(): void;
}

interface SessionToolState {
  clearSessionState(): void;
}

interface SessionResourceState {
  reload(): Promise<unknown>;
}

export interface AgentSessionActivationOptions {
  parentAgent: ParentAgentRuntime;
  sessionEvents: SessionPersistenceState;
  sessionState: SessionVolatileState;
  toolCalls: SessionToolState;
  runtimeResources: SessionResourceState;
}

export interface ActivateSessionOptions {
  reloadResources?: boolean;
}

export class AgentSessionActivation {
  constructor(private readonly options: AgentSessionActivationOptions) {}

  get currentAgent(): Agent | null {
    return this.options.parentAgent.current;
  }

  detachAgent(): void {
    this.options.parentAgent.detach();
  }

  async activate(messages: AgentMessage[], options: ActivateSessionOptions = {}): Promise<void> {
    this.resetSessionLocalState(messages);
    if (options.reloadResources !== false) await this.options.runtimeResources.reload();
    this.options.parentAgent.replace(messages);
  }

  private resetSessionLocalState(messages: AgentMessage[]): void {
    this.options.sessionEvents.markPersistedMessages(messages);
    this.options.sessionState.reset();
    this.options.toolCalls.clearSessionState();
  }
}
