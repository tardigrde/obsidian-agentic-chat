import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { PromptTurnRun } from "./prompt-turn-runtime";

/**
 * Owns the user text that was queued into a running turn but never reached the
 * model. pi polls its steering and follow-up queues only between model turns,
 * so a run that ends early (stop, turn cap, loop guard) or a steer that lands
 * after the last poll leaves messages queued, and the next prompt would deliver
 * them as new. Every path that ends a run drains the queues here; the composer
 * takes the text back.
 */
export class AgentSteeringQueue {
  private readonly undelivered: string[] = [];

  /** Each undelivered text is returned once; the UI puts it back in the composer. */
  takeUndelivered(): string[] {
    return this.undelivered.splice(0);
  }

  /**
   * The one stop policy: clear the queues first, then abort, so a queued
   * message cannot drain into the next run.
   */
  stop(agent: Agent): void {
    this.drain(agent);
    agent.abort();
  }

  /**
   * Drain the idle agent before and after `run`, inside the prompt turn, so
   * the UI sees the undelivered text on the run's settle notification.
   */
  settling(run: PromptTurnRun): PromptTurnRun {
    return async (agent) => {
      this.drain(agent);
      try {
        await run(agent);
      } finally {
        if (!agent.state.isStreaming) this.drain(agent);
      }
    };
  }

  /** Empty both queues and keep the user text they carried as undelivered. */
  private drain(agent: Agent): void {
    if (!agent.hasQueuedMessages()) return;
    const { steeringMode, followUpMode } = agent;
    // "all" makes peek return the whole queue, not just its head.
    agent.steeringMode = "all";
    agent.followUpMode = "all";
    try {
      const steering = agent.peekQueuedMessages();
      agent.clearSteeringQueue();
      // With an empty steering queue both peeks return the follow-ups.
      const queued = new Set([...steering, ...agent.peekQueuedMessages()]);
      agent.clearAllQueues();
      for (const message of queued) {
        const text = queuedUserText(message);
        if (text) this.undelivered.push(text);
      }
    } finally {
      agent.steeringMode = steeringMode;
      agent.followUpMode = followUpMode;
    }
  }
}

function queuedUserText(message: AgentMessage): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}
