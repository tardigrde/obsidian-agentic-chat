import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { conversationMessages, isSystemContextMessage, splitAgentMessages } from "../src/agent/conversation-messages";

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistant(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 2 } as AgentMessage;
}

/**
 * pi 1.0.0 seeds a leading system message from `initialState.systemPrompt` and
 * only does so when the transcript does not already start with one. That makes
 * the plugin's system-message handling load-bearing: getting it wrong means a
 * rehydrated session keeps a stale prompt, or `refreshConfiguration` fails to
 * swap the prompt in.
 */
function agentWith(systemPrompt: string, messages: AgentMessage[]): Agent {
  return new Agent({
    streamFn: () => createAssistantMessageEventStream(),
    initialState: { systemPrompt, messages },
  });
}

describe("conversationMessages", () => {
  it("drops the system-context message and keeps the conversation", () => {
    const agent = agentWith("you are helpful", [user("hi"), assistant("hello")]);
    expect(agent.state.messages[0]?.role).toBe("system");

    const conversation = conversationMessages(agent.state.messages);

    expect(conversation.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("preserves message identity so session de-dupe keeps working", () => {
    const first = user("one");
    const second = assistant("two");
    const conversation = conversationMessages([
      { role: "system", content: "prompt", timestamp: 0 } as AgentMessage,
      first,
      second,
    ]);
    expect(conversation[0]).toBe(first);
    expect(conversation[1]).toBe(second);
  });

  it("is a no-op when the transcript carries no system message", () => {
    const messages = [user("hi"), assistant("hello")];
    expect(conversationMessages(messages)).toEqual(messages);
  });
});

describe("isSystemContextMessage", () => {
  it("classifies only system messages", () => {
    expect(isSystemContextMessage({ role: "system", content: "p", timestamp: 0 } as AgentMessage)).toBe(true);
    expect(isSystemContextMessage(user("hi"))).toBe(false);
  });
});

describe("splitAgentMessages", () => {
  it("separates system context from conversation", () => {
    const { system, conversation } = splitAgentMessages([
      { role: "system", content: "prompt", timestamp: 0 } as AgentMessage,
      user("hi"),
    ]);
    expect(system).toHaveLength(1);
    expect(conversation.map((message) => message.role)).toEqual(["user"]);
  });
});

describe("system prompt ownership (pi 1.0.0)", () => {
  it("seeds a system message from initialState.systemPrompt", () => {
    const agent = agentWith("original prompt", []);
    expect(agent.state.systemPrompt).toBe("original prompt");
    expect(agent.state.messages[0]).toMatchObject({ role: "system", content: "original prompt" });
  });

  // Guards the reason the plugin filters system messages out: when a persisted
  // system message leads the transcript, `Agent` does NOT re-seed one, so the
  // stale prompt would stay in force for the whole session.
  it("does not re-seed the prompt when the transcript already starts with a system message", () => {
    const agent = agentWith("fresh prompt", [
      { role: "system", content: "stale prompt", timestamp: 0 } as AgentMessage,
      user("hi"),
    ]);
    expect(agent.state.systemPrompt).toBe("stale prompt");
  });

  it("keeps the freshly composed prompt in force when the persisted system message is dropped", () => {
    const rehydrated = agentWith("fresh prompt", conversationMessages([
      { role: "system", content: "stale prompt", timestamp: 0 } as AgentMessage,
      user("hi"),
    ]));
    expect(rehydrated.state.systemPrompt).toBe("fresh prompt");
  });

  it("rewrites the leading system message so a refresh replaces the prompt", () => {
    const agent = agentWith("original prompt", [user("hi")]);
    const messages = agent.state.messages;
    messages[0] = { ...(messages[0] as AgentMessage & { role: "system" }), content: "updated prompt" };
    agent.state.messages = messages;

    expect(agent.state.systemPrompt).toBe("updated prompt");
    // Replacement, not accumulation: still exactly one system message.
    expect(agent.state.messages.filter((message) => message.role === "system")).toHaveLength(1);
  });
});