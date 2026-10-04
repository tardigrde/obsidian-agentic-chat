import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentOptions,
  type AgentTool,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

type BeforeToolCall = NonNullable<AgentOptions["beforeToolCall"]>;
type AfterToolCall = NonNullable<AgentOptions["afterToolCall"]>;
// pi 0.87.0 removed `shouldStopAfterTurn`; `finishTurn` ends a normal run by
// returning `{ action: "end" }`.
type FinishTurn = NonNullable<AgentOptions["finishTurn"]>;

export interface ParentAgentOptions {
  streamFn: StreamFn;
  systemPrompt: string;
  model: Model<"openai-completions">;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  messages: AgentMessage[];
  getApiKey: (provider: string) => Promise<string | undefined> | string | undefined;
  beforeToolCall: BeforeToolCall;
  afterToolCall: AfterToolCall;
  finishTurn?: FinishTurn;
  sessionId?: string;
  onEvent: (event: AgentEvent) => Promise<void> | void;
}

export interface ParentAgentHandle {
  agent: Agent;
  unsubscribe: () => void;
}

export function createParentAgent(options: ParentAgentOptions): ParentAgentHandle {
  const agent = new Agent({
    streamFn: options.streamFn,
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      tools: options.tools,
      messages: options.messages,
    },
    getApiKey: options.getApiKey,
    beforeToolCall: options.beforeToolCall,
    afterToolCall: options.afterToolCall,
    finishTurn: options.finishTurn,
    sessionId: options.sessionId,
    // N `subagent` calls in one message run concurrently; the subagent tool's
    // own semaphore caps the fan-out. Stateful/interactive tools (ask-user)
    // declare executionMode "sequential", which the SDK honours by serializing
    // any batch that contains them.
    toolExecution: "parallel",
  });
  return {
    agent,
    unsubscribe: agent.subscribe((event) => options.onEvent(event)),
  };
}
