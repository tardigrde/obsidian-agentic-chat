import { describe, expect, it } from "vitest";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { AgentSessionActivation } from "../src/agent/session-activation";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function agentWith(messages: AgentMessage[]): Agent {
  return { state: { messages, isStreaming: false } } as Agent;
}

function makeActivation(agent: Agent | null = null): { activation: AgentSessionActivation; events: string[] } {
  const events: string[] = [];
  let current = agent;
  const activation = new AgentSessionActivation({
    parentAgent: {
      get current() {
        return current;
      },
      detach: () => {
        events.push("detach");
        current = null;
      },
      replace: (messages) => {
        events.push(`replace:${messages.length}`);
        current = agentWith(messages);
        return current;
      },
    },
    sessionEvents: {
      markPersistedMessages: (messages) => events.push(`persist:${messages.length}`),
    },
    sessionState: {
      reset: () => events.push("state:reset"),
    },
    toolCalls: {
      clearSessionState: () => events.push("tools:clear"),
    },
    runtimeResources: {
      reload: async () => {
        events.push("resources:reload");
      },
    },
  });
  return { activation, events };
}

describe("AgentSessionActivation", () => {
  it("resets session-local state, reloads resources, then replaces the parent agent", async () => {
    const { activation, events } = makeActivation();

    await activation.activate([userMessage("loaded")]);

    expect(events).toEqual(["persist:1", "state:reset", "tools:clear", "resources:reload", "replace:1"]);
    expect(activation.currentAgent?.state.messages).toEqual([userMessage("loaded")]);
  });

  it("can replace a rewritten transcript without reloading resources", async () => {
    const { activation, events } = makeActivation();

    await activation.activate([userMessage("rewound")], { reloadResources: false });

    expect(events).toEqual(["persist:1", "state:reset", "tools:clear", "replace:1"]);
  });

  it("exposes the live parent agent and detaches it", () => {
    const { activation, events } = makeActivation(agentWith([userMessage("active")]));

    expect(activation.currentAgent?.state.messages).toEqual([userMessage("active")]);
    activation.detachAgent();

    expect(events).toEqual(["detach"]);
    expect(activation.currentAgent).toBeNull();
  });
});
