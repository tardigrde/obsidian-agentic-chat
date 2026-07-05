import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

export interface AgentEventHandlerOptions {
  recordMessageEnd: (message: AgentMessage) => Promise<void>;
  recordAgentEnd: (messages: AgentMessage[]) => Promise<void>;
  recordAuditEvent?: (event: AgentEvent) => Promise<void>;
  enforceSpendCap: () => void;
  setError: (error: unknown) => void;
  emitEvent: (event: AgentEvent) => void;
  hasActiveSession: () => boolean;
  refreshActiveSessionInfo: () => void;
  notifyChange: () => void;
}

export async function handleAgentRuntimeEvent(event: AgentEvent, options: AgentEventHandlerOptions): Promise<void> {
  try {
    await options.recordAuditEvent?.(event);
  } catch (error) {
    options.setError(error);
  }

  try {
    if (event.type === "message_end") {
      await options.recordMessageEnd(event.message);
      if (event.message.role === "assistant") options.enforceSpendCap();
    }
    // A subagent dispatch accrues cost during tool execution; check here too so
    // a costly fan-out aborts as soon as it finishes, not only at the next turn.
    if (event.type === "tool_execution_end") options.enforceSpendCap();
    if (event.type === "agent_end") {
      await options.recordAgentEnd(event.messages);
    }
  } catch (error) {
    options.setError(error);
  }

  options.emitEvent(event);
  if (event.type === "agent_end" || event.type === "agent_start") {
    if (options.hasActiveSession()) options.refreshActiveSessionInfo();
    options.notifyChange();
  }
}
