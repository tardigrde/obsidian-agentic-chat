import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { createParentAgent, type ParentAgentOptions } from "./parent-agent";
import { ParentAgentLifecycle } from "./parent-agent-lifecycle";

export type ParentAgentRuntimeConfiguration = Omit<ParentAgentOptions, "messages">;

export class ParentAgentRuntime {
  private readonly lifecycle = new ParentAgentLifecycle();

  constructor(private readonly buildConfiguration: () => ParentAgentRuntimeConfiguration) {}

  get current(): Agent | null {
    return this.lifecycle.current;
  }

  get isDisposed(): boolean {
    return this.lifecycle.isDisposed;
  }

  replace(messages: AgentMessage[]): Agent | null {
    return this.lifecycle.replace(() => createParentAgent({ ...this.buildConfiguration(), messages }));
  }

  refreshConfiguration(): Agent {
    const agent = this.requireAgent();
    const configuration = this.buildConfiguration();
    agent.state.model = configuration.model;
    agent.state.thinkingLevel = configuration.thinkingLevel;
    agent.state.tools = configuration.tools;
    agent.state.systemPrompt = configuration.systemPrompt;
    return agent;
  }

  detach(): void {
    this.lifecycle.detach();
  }

  dispose(): boolean {
    return this.lifecycle.dispose();
  }

  requireAgent(): Agent {
    const agent = this.current;
    if (!agent) throw new Error("Agent is not initialized.");
    return agent;
  }
}
