/**
 * Serializes session swaps so rapid UI triggers cannot interleave
 * detach/create/load/replace work across sessions. A failed swap is still
 * reported to its caller, but it must not poison the queue for the next swap.
 */
export class AgentSessionSwapQueue {
  private current: Promise<void> = Promise.resolve();

  enqueue(op: () => Promise<void>): Promise<void> {
    const next = this.current.then(op, op);
    this.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
