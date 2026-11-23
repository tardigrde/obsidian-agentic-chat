import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { SubagentDetails } from "../tools/subagent-tool";

export type AgentServiceEventListener = (event: AgentEvent) => void;
export type AgentServiceChangeListener = () => void;
/** Live status of a background child, for its row (U5 #1); after its dispatch call returned. */
export type AgentServiceSubagentListener = (toolCallId: string, details: SubagentDetails) => void;

export class AgentServiceListeners {
  private readonly eventListeners = new Set<AgentServiceEventListener>();
  private readonly changeListeners = new Set<AgentServiceChangeListener>();
  private readonly subagentListeners = new Set<AgentServiceSubagentListener>();

  onSubagentUpdate(listener: AgentServiceSubagentListener): () => void {
    this.subagentListeners.add(listener);
    return () => this.subagentListeners.delete(listener);
  }

  emitSubagentUpdate(toolCallId: string, details: SubagentDetails): void {
    for (const listener of this.subagentListeners) listener(toolCallId, details);
  }

  onEvent(listener: AgentServiceEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onChange(listener: AgentServiceChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  emitEvent(event: AgentEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  notifyChange(): void {
    for (const listener of this.changeListeners) listener();
  }

  clear(): void {
    this.eventListeners.clear();
    this.changeListeners.clear();
    this.subagentListeners.clear();
  }
}
