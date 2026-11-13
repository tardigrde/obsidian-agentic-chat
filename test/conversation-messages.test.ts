import { describe, expect, it } from "vitest";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { conversationMessages } from "../src/agent/conversation-messages";

function user(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistant(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 2 } as AgentMessage;
}

function system(content: string): AgentMessage {
  return { role: "system", content, timestamp: 0 } as AgentMessage;
}

describe("conversationMessages", () => {
  it("drops the system-context message and keeps the conversation", () => {
    const agent = new Agent({
      streamFn: () => createAssistantMessageEventStream(),
      initialState: { systemPrompt: "you are helpful", messages: [user("hi"), assistant("hello")] },
    });
    expect(agent.state.messages[0]?.role).toBe("system");

    expect(conversationMessages(agent.state.messages).map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("preserves message identity so session de-dupe keeps working", () => {
    const first = user("one");
    const second = assistant("two");
    const conversation = conversationMessages([system("prompt"), first, second]);

    expect(conversation[0]).toBe(first);
    expect(conversation[1]).toBe(second);
  });

  it("is a no-op when the transcript carries no system message", () => {
    const messages = [user("hi"), assistant("hello")];
    expect(conversationMessages(messages)).toEqual(messages);
  });
});
