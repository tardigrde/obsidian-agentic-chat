import type { AgentEvent } from "@earendil-works/pi-agent-core";

export type AgentServiceEventListener = (event: AgentEvent) => void;
export type AgentServiceChangeListener = () => void;

export class AgentServiceListeners {
  private readonly eventListeners = new Set<AgentServiceEventListener>();
  private readonly changeListeners = new Set<AgentServiceChangeListener>();

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
  }
}
