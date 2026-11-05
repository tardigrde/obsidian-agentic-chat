/**
 * Lifecycle of the active session swap. `idle` means no swap has run yet,
 * `live` means the last swap completed, and `failed` means the last swap threw.
 * A new enqueue recovers from `failed` when it succeeds.
 */
export type AgentSessionSwapState = "idle" | "queued" | "loading" | "activating" | "live" | "failed";

export type AgentSessionSwapPhase = "loading" | "activating";

export type AgentSessionSwapOperation<T> = (
  setPhase: (phase: AgentSessionSwapPhase) => void,
) => Promise<T>;

/**
 * Serializes session swaps so rapid UI triggers cannot interleave
 * detach/create/load/replace work across sessions. A failed swap is still
 * reported to its caller, but it must not poison the queue for the next swap.
 */
export class AgentSessionSwapQueue {
  private current: Promise<void> = Promise.resolve();
  private pending = 0;
  private _state: AgentSessionSwapState = "idle";

  get state(): AgentSessionSwapState {
    return this._state;
  }

  enqueue<T>(op: AgentSessionSwapOperation<T>): Promise<T> {
    this.pending += 1;
    this._state = "queued";
    const next = this.current.then(
      () => this.execute(op),
      () => this.execute(op),
    );
    this.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next.finally(() => {
      this.pending -= 1;
      if (this.pending > 0) {
        this._state = "queued";
      } else if (this._state !== "failed") {
        this._state = "live";
      }
    });
  }

  /** Resolve after every queued swap settles; returns the resulting state. */
  async waitForSettled(): Promise<AgentSessionSwapState> {
    await this.current;
    return this._state;
  }

  private async execute<T>(op: AgentSessionSwapOperation<T>): Promise<T> {
    this._state = "loading";
    try {
      const result = await op((phase) => {
        this._state = phase;
      });
      this._state = "live";
      return result;
    } catch (error) {
      this._state = "failed";
      throw error;
    }
  }
}
