import { describe, expect, it } from "vitest";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { handleAgentRuntimeEvent, type AgentEventHandlerOptions } from "../src/agent/agent-event-handler";

function userMessage(text = "hello"): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistantMessage(text = "ok"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 2,
  } as AgentMessage;
}

function options(events: string[], overrides: Partial<AgentEventHandlerOptions> = {}): AgentEventHandlerOptions {
  return {
    recordMessageEnd: async (message) => {
      events.push(`record-message:${message.role}`);
    },
    recordAgentEnd: async (messages) => {
      events.push(`record-agent:${messages.length}`);
    },
    enforceSpendCap: () => {
      events.push("enforce-cap");
    },
    setError: (error) => {
      events.push(`error:${error instanceof Error ? error.message : String(error)}`);
    },
    emitEvent: (event) => {
      events.push(`emit:${event.type}`);
    },
    hasActiveSession: () => true,
    refreshActiveSessionInfo: () => {
      events.push("refresh-session");
    },
    notifyChange: () => {
      events.push("notify");
    },
    ...overrides,
  };
}

describe("handleAgentRuntimeEvent", () => {
  it("records assistant message_end before enforcing the spend cap and emitting", async () => {
    const events: string[] = [];

    await handleAgentRuntimeEvent({ type: "message_end", message: assistantMessage() }, options(events));

    expect(events).toEqual(["record-message:assistant", "enforce-cap", "emit:message_end"]);
  });

  it("does not enforce the spend cap for user message_end events", async () => {
    const events: string[] = [];

    await handleAgentRuntimeEvent({ type: "message_end", message: userMessage() }, options(events));

    expect(events).toEqual(["record-message:user", "emit:message_end"]);
  });

  it("enforces the spend cap after tool execution end events", async () => {
    const events: string[] = [];
    const event: AgentEvent = {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: "ok",
      isError: false,
    };

    await handleAgentRuntimeEvent(event, options(events));

    expect(events).toEqual(["enforce-cap", "emit:tool_execution_end"]);
  });

  it("records agent_end, emits it, refreshes active session info, and notifies", async () => {
    const events: string[] = [];

    await handleAgentRuntimeEvent(
      { type: "agent_end", messages: [userMessage(), assistantMessage()] },
      options(events),
    );

    expect(events).toEqual(["record-agent:2", "emit:agent_end", "refresh-session", "notify"]);
  });

  it("captures persistence errors but still emits and notifies", async () => {
    const events: string[] = [];

    await handleAgentRuntimeEvent(
      { type: "agent_end", messages: [userMessage()] },
      options(events, {
        recordAgentEnd: async () => {
          events.push("record-agent");
          throw new Error("write failed");
        },
      }),
    );

    expect(events).toEqual(["record-agent", "error:write failed", "emit:agent_end", "refresh-session", "notify"]);
  });

  it("captures audit errors but still persists and emits the runtime event", async () => {
    const events: string[] = [];

    await handleAgentRuntimeEvent(
      { type: "message_end", message: assistantMessage() },
      options(events, {
        recordAuditEvent: async () => {
          events.push("audit");
          throw new Error("audit failed");
        },
      }),
    );

    expect(events).toEqual(["audit", "error:audit failed", "record-message:assistant", "enforce-cap", "emit:message_end"]);
  });

  it("records audit events before tool spend-cap enforcement", async () => {
    const events: string[] = [];
    const event: AgentEvent = {
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: "ok",
      isError: false,
    };

    await handleAgentRuntimeEvent(
      event,
      options(events, {
        recordAuditEvent: async (agentEvent) => {
          events.push(`audit:${agentEvent.type}`);
        },
      }),
    );

    expect(events).toEqual(["audit:tool_execution_end", "enforce-cap", "emit:tool_execution_end"]);
  });

  it("skips session-info refresh when no session is active", async () => {
    const events: string[] = [];

    await handleAgentRuntimeEvent(
      { type: "agent_start" },
      options(events, {
        hasActiveSession: () => false,
      }),
    );

    expect(events).toEqual(["emit:agent_start", "notify"]);
  });
});
