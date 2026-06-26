import type { Usage } from "@earendil-works/pi-ai";
import { ReadMemo } from "../vault/read-memo";
import { addUsage, emptyUsage } from "./usage";

export class AgentSessionLocalState {
  /** De-dupes repeat `read` calls so re-reading can't double a file into the context window. */
  readonly readMemo = new ReadMemo();

  private errorMessage: string | undefined;
  /** Child usage lives outside the parent transcript and is reset on session swaps/rewinds. */
  private childUsage: Usage = emptyUsage();

  get error(): string | undefined {
    return this.errorMessage;
  }

  get subagentUsage(): Usage {
    return this.childUsage;
  }

  recordSubagentUsage(usage: Usage): void {
    addUsage(this.childUsage, usage);
  }

  setError(error: unknown): void {
    this.errorMessage = error instanceof Error ? error.message : String(error);
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
    this.childUsage = emptyUsage();
    this.readMemo.clear();
    this.errorMessage = undefined;
  }
}
