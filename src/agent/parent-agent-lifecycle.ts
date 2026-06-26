import type { Agent } from "@earendil-works/pi-agent-core";
import type { ParentAgentHandle } from "./parent-agent";

export class ParentAgentLifecycle {
  private agent: Agent | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;

  get current(): Agent | null {
    return this.agent;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  replace(create: () => ParentAgentHandle): Agent | null {
    if (this.disposed) return null;
    this.unsubscribe?.();
    const handle = create();
    this.agent = handle.agent;
    this.unsubscribe = handle.unsubscribe;
    return this.agent;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.agent?.abort();
    this.agent = null;
  }

  dispose(): boolean {
    if (this.disposed) return false;
    this.disposed = true;
    this.detach();
    return true;
  }
}
