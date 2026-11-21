import type { Usage } from "@earendil-works/pi-ai";
import { ReadMemo } from "../vault/read-memo";
import { addUsage, emptyUsage } from "./usage";
import { errorMessage } from "../utils/errors";

export class AgentSessionLocalState {
  /** De-dupes repeat `read` calls so re-reading can't double a file into the context window. */
  readonly readMemo = new ReadMemo();

  private errorMessage: string | undefined;
  /**
   * Usage of dispatches still running, by dispatch (tool call) id. A finished
   * dispatch's usage is read from its tool result in the transcript instead,
   * so it survives a reload; reset on session swaps/rewinds.
   */
  private readonly childUsage = new Map<string, Usage>();

  get error(): string | undefined {
    return this.errorMessage;
  }

  /** Usage of the dispatches still running (their tool result is not in the transcript yet). */
  get subagentUsage(): Usage {
    const total = emptyUsage();
    for (const usage of this.childUsage.values()) addUsage(total, usage);
    return total;
  }

  /** A dispatch's tool result landed in the transcript, which now carries its usage. */
  settleSubagentUsage(dispatchId: string): void {
    this.childUsage.delete(dispatchId);
  }

  recordSubagentUsage(usage: Usage, dispatchId = "unknown"): void {
    const current = this.childUsage.get(dispatchId) ?? emptyUsage();
    addUsage(current, usage);
    this.childUsage.set(dispatchId, current);
  }

  setError(error: unknown): void {
    this.errorMessage = errorMessage(error);
  }

  setErrorMessage(message: string): void {
    this.errorMessage = message;
  }

  clearError(): void {
    this.errorMessage = undefined;
  }

  invalidateRead(path: string): void {
    this.readMemo.invalidate(path);
  }

  reset(): void {
    this.childUsage.clear();
    this.readMemo.clear();
    this.errorMessage = undefined;
  }
}
