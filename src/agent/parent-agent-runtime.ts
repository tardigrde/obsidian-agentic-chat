import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { conversationMessages } from "./conversation-messages";
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

  /**
   * Install a conversation transcript on a fresh agent.
   *
   * Any system message in `messages` is dropped: pi 1.0.0 seeds its own leading
   * system message from `initialState.systemPrompt`, and it only does so when
   * the transcript does not already start with one. Passing a persisted system
   * message through would therefore keep a stale prompt in force for the whole
   * session instead of the freshly composed one.
   */
  replace(messages: AgentMessage[]): Agent | null {
    const conversation = conversationMessages(messages);
    return this.lifecycle.replace(() => createParentAgent({ ...this.buildConfiguration(), messages: conversation }));
  }

  refreshConfiguration(): Agent {
    const agent = this.requireAgent();
    const configuration = this.buildConfiguration();
    agent.state.model = configuration.model;
    agent.state.thinkingLevel = configuration.thinkingLevel;
    agent.state.tools = configuration.tools;
    replaceSystemPrompt(agent, configuration.systemPrompt);
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

/**
 * Swap the agent's system prompt in place.
 *
 * pi 1.0.0 makes `state.systemPrompt` read-only: the prompt is replayed from
 * the transcript's system messages, and mid-conversation changes are made by
 * appending a system message rather than mutating state. Refreshing config on a
 * live agent must replace the prompt outright, not append a delta, so rewrite
 * the leading system message's `content` instead. Its `toolsAdded` is left
 * alone because tool changes are declared separately by assigning
 * `state.tools`, which the agent loop diffs and announces itself.
 *
 * A leading system message is expected because the agent seeds one from
 * `initialState.systemPrompt`; when the prompt is empty and no message exists
 * there is nothing to rewrite.
 */
function replaceSystemPrompt(agent: Agent, systemPrompt: string): void {
  const messages = agent.state.messages;
  const first = messages[0];
  if (!first || first.role !== "system") return;
  if (first.content === systemPrompt) return;
  messages[0] = { ...first, content: systemPrompt };
  // Assigning the array is what publishes the edit to the agent's state.
  agent.state.messages = messages;
}
