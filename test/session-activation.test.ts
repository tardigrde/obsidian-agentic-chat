import { describe, expect, it } from "vitest";
import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { AgentSessionActivation } from "../src/agent/session-activation";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function agentWith(messages: AgentMessage[]): Agent {
  return { state: { messages, isStreaming: false } } as Agent;
}

function makeActivation(
  agent: Agent | null = null,
  options: { failReload?: boolean } = {},
): { activation: AgentSessionActivation; events: string[]; initialAgent: Agent | null } {
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
      clearSessionState: () => events.push("resources:clear"),
      reload: async () => {
        events.push("resources:reload");
        if (options.failReload) throw new Error("resource reload failed");
      },
    },
  });
  return { activation, events, initialAgent: agent };
}

describe("AgentSessionActivation", () => {
  it("reloads resources before resetting state and replacing the parent agent", async () => {
    const { activation, events } = makeActivation();

    await activation.activate([userMessage("loaded")]);

    expect(events).toEqual(["resources:reload", "persist:1", "state:reset", "tools:clear", "resources:clear", "replace:1"]);
    expect(activation.currentAgent?.state.messages).toEqual([userMessage("loaded")]);
  });

  it("keeps the live agent and session state when the resource reload fails", async () => {
    const active = agentWith([userMessage("active")]);
    const { activation, events } = makeActivation(active, { failReload: true });

    await expect(activation.activate([userMessage("loaded")])).rejects.toThrow("resource reload failed");

    expect(events).toEqual(["resources:reload"]);
    expect(activation.currentAgent).toBe(active);
    expect(activation.currentAgent?.state.messages).toEqual([userMessage("active")]);
  });

  it("can replace a rewritten transcript without reloading resources", async () => {
    const { activation, events } = makeActivation();

    await activation.activate([userMessage("rewound")], { reloadResources: false });

    expect(events).toEqual(["persist:1", "state:reset", "tools:clear", "resources:clear", "replace:1"]);
  });

  it("exposes the live parent agent and detaches it", () => {
    const { activation, events } = makeActivation(agentWith([userMessage("active")]));

    expect(activation.currentAgent?.state.messages).toEqual([userMessage("active")]);
    activation.detachAgent();

    expect(events).toEqual(["detach"]);
    expect(activation.currentAgent).toBeNull();
  });
});
