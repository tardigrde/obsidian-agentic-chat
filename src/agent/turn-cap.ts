import type { AgentTurnContext } from "@earendil-works/pi-agent-core";

/** Assistant-turn budget for one parent prompt epoch. */
export const PARENT_TURN_CAP = 25;

/** Assistant-turn budget for one subagent child run. */
export const CHILD_TURN_CAP = 10;

/** Static prefix kept for tests/grep; fired notices append the limit. */
export const TURN_CAP_NOTICE_TEXT = "Turn cap: stopped after the assistant turn limit.";

/** Build the fired notice shown in the transcript and as a transient Notice. */
export function buildTurnCapNotice(maxTurns: number): string {
  return `Turn cap: stopped after ${maxTurns} assistant turns. Send another message to continue.`;
}

export interface AgentTurnCapOptions {
  /** Assistant turns allowed in one prompt epoch. Defaults to 25. */
  maxTurns?: number;
}

/**
 * Harness-level assistant-turn budget for one prompt epoch. It is the count
 * axis, not the cost axis: a cheap or free model can vary its calls forever and
 * never trip the spend cap or the identical-batch loop guard.
 *
 * Wired into the parent `finishTurn` hook after the loop guard. A fire ends the
 * run gracefully before another model call. User-scoped: reset() runs on every
 * fresh prompt, so only turns inside one run count.
 */
export class AgentTurnCap {
  private turns = 0;
  private firedText: string | null = null;

  constructor(private readonly options: AgentTurnCapOptions = {}) {}

  get maxTurns(): number {
    const configured = this.options.maxTurns ?? PARENT_TURN_CAP;
    // A malformed threshold must never disable the cap or make it unbounded.
    return Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : PARENT_TURN_CAP;
  }

  /** Non-null once the cap has fired, until the next reset(). */
  get noticeText(): string | null {
    return this.firedText;
  }

  /** Forget the turn count and any fired notice. Called on every fresh prompt. */
  reset(): void {
    this.turns = 0;
    this.firedText = null;
  }

  /**
   * Count one completed assistant turn and report whether the run must stop.
   * Tool-free turns count too: the budget is about model calls, not tools.
   *
   * Hook contract (pi-agent-core): must not throw on an unexpected message
   * shape. Malformed turns still count; a bad shape must not break the run.
   */
  shouldStopAfterTurn(turn: AgentTurnContext): boolean {
    try {
      const stopReason = (turn as AgentTurnContext | undefined)?.message?.stopReason;
      // Error and aborted responses are hard exits in pi; do not spend budget
      // on them or set a stop notice for a run that was ending anyway.
      if (stopReason === "error" || stopReason === "aborted") return false;
      this.turns += 1;
      if (this.turns < this.maxTurns) return false;
      this.firedText ??= buildTurnCapNotice(this.maxTurns);
      return true;
    } catch {
      return false;
    }
  }
}
