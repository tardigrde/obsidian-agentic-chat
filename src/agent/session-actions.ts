import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { LoadSessionOptions, SessionInfo } from "../session/session-manager";
import type { ActivateSessionOptions, ActiveSessionSnapshot } from "./conversation";
import { conversationMessages } from "./conversation-messages";
import { AgentSessionSwapQueue, type AgentSessionSwapState } from "./session-swap-queue";

export interface AgentSessionActionsRuntime {
  readonly activePath: string | null;
  /** Advances on every transcript discontinuity; a rewrite must still match it. */
  readonly generation: number;
  /** The generation the current conversation began at; a send must still match it. */
  readonly conversationGeneration: number;
  /** Commit a swap or rewind: every older token is stale from here on. */
  beginConversation(): number;
  continueRecent(): Promise<ActiveSessionSnapshot>;
  create(): Promise<ActiveSessionSnapshot>;
  load(path: string, options?: LoadSessionOptions): Promise<ActiveSessionSnapshot>;
  list(): Promise<SessionInfo[]>;
  delete(path: string): Promise<void>;
  rename(path: string, name: string): Promise<void>;
  rewriteMessages(
    messages: AgentMessage[],
    options?: { expectedPath?: string | null; expectedGeneration?: number },
  ): Promise<ActiveSessionSnapshot>;
  refreshInfoIfActive(): SessionInfo | undefined;
}

export interface AgentSessionActivationRuntime {
  readonly currentAgent: Agent | null;
  prepareResources(): Promise<void>;
  detachAgent(): void;
  activate(messages: AgentMessage[], options?: ActivateSessionOptions): Promise<void>;
  /** Put a transcript the session file already holds on a fresh agent. */
  installTranscript(messages: AgentMessage[]): unknown;
}

/** The session and generation a caller captured together with its transcript. */
export interface SessionBinding {
  expectedPath: string | null;
  expectedGeneration: number;
}

/**
 * The session file holds the compacted transcript, but neither the install nor
 * a reload could put it on the live agent.
 */
export class CompactionNotLiveError extends Error {
  constructor(cause: unknown) {
    super("The compacted transcript is saved, but the live conversation could not be replaced.", { cause });
    this.name = "CompactionNotLiveError";
  }
}

export interface AgentSessionActionsOptions {
  sessions: AgentSessionActionsRuntime;
  activation: AgentSessionActivationRuntime;
  notifyChange: () => void;
  afterDelete?: () => void | Promise<void>;
}

/**
 * The only sequencer for the live session. Every operation that moves the
 * session pointer, rewrites the transcript, or replaces the live agent runs as
 * one step of this queue, so no two of them interleave.
 */
export class AgentSessionActions {
  private readonly sessionSwaps = new AgentSessionSwapQueue();

  constructor(private readonly options: AgentSessionActionsOptions) {}

  getSwapState(): AgentSessionSwapState {
    const state = this.sessionSwaps.state;
    // A failed swap that left a live agent is not a blocked UI: sends and the
    // queued-prompt flush can still use that agent. Only report failure when no
    // agent survived; the next swap retries and clears it.
    return state === "failed" && this.options.activation.currentAgent ? "live" : state;
  }

  /**
   * The conversation a send binds to. It changes when a swap or rewind commits
   * and survives compaction.
   */
  getSessionToken(): number {
    return this.options.sessions.conversationGeneration;
  }

  /** The session and generation a rewrite must still match when it lands. */
  getBinding(): SessionBinding {
    return {
      expectedPath: this.options.sessions.activePath,
      expectedGeneration: this.options.sessions.generation,
    };
  }

  /**
   * Advance the token only when a swap is committed to changing the session.
   * A failure before this point leaves the old session live, so a prompt
   * prepared against it must still be accepted.
   */
  private commitSessionChange(): number {
    return this.options.sessions.beginConversation();
  }

  /**
   * Wait for any in-flight swap. A failed swap is not sticky: when no agent
   * survived, the caller falls through to {@link ensureSessionAgent}, which
   * retries the recent session on the next send or session action.
   */
  async waitForLive(): Promise<void> {
    await this.sessionSwaps.waitForSettled();
  }

  /** Startup path: continue the recent session only when no agent is live. */
  async ensureSessionAgent(): Promise<void> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      if (this.options.activation.currentAgent) return;
      await this.loadIntoNewAgent(setPhase, () => this.options.sessions.continueRecent());
    });
  }

  async continueRecentSession(): Promise<void> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      await this.loadIntoNewAgent(setPhase, () => this.options.sessions.continueRecent());
    });
  }

  async newSession(): Promise<void> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      const previousPath = this.options.sessions.activePath;
      await this.options.activation.prepareResources();
      // Commit only after the resource reload succeeds. A failed reload leaves
      // the old session live, so its token must stay valid for queued prompts.
      this.commitSessionChange();
      // Stop the old agent before the session pointer moves, so a late
      // message_end/agent_end cannot land in the new file.
      this.options.activation.detachAgent();
      setPhase("loading");
      let messages: AgentMessage[];
      try {
        ({ messages } = await this.options.sessions.create());
      } catch (error) {
        if (await this.restorePreviousSession(previousPath, setPhase)) {
          throw new Error("Could not create a new session; the previous session is still open.", { cause: error });
        }
        throw error;
      }
      setPhase("activating");
      await this.activateSession(messages);
    });
  }

  listSessions(): Promise<SessionInfo[]> {
    return this.options.sessions.list();
  }

  async loadSession(path: string): Promise<void> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      const previousPath = this.options.sessions.activePath;
      // Reload before detaching: a failed reload must leave the previous agent
      // and its session-local state intact.
      await this.options.activation.prepareResources();
      this.commitSessionChange();
      this.options.activation.detachAgent();
      setPhase("loading");
      let messages: AgentMessage[];
      try {
        ({ messages } = await this.options.sessions.load(path));
      } catch (error) {
        if (await this.restorePreviousSession(previousPath, setPhase)) {
          throw new Error(`Could not load ${path}; the previous session is still open.`, { cause: error });
        }
        throw error;
      }
      setPhase("activating");
      await this.activateSession(messages);
    });
  }

  async deleteSession(path: string): Promise<void> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      const active = this.options.sessions.activePath;
      if (active !== path) {
        await this.options.sessions.delete(path);
        await this.options.afterDelete?.();
        this.options.notifyChange();
        return;
      }
      await this.options.activation.prepareResources();
      this.commitSessionChange();
      this.options.activation.detachAgent();
      setPhase("loading");
      try {
        await this.options.sessions.delete(path);
        await this.options.afterDelete?.();
        const { messages } = await this.options.sessions.create();
        setPhase("activating");
        await this.activateSession(messages);
      } catch (error) {
        if (await this.recoverLiveSession(path, setPhase)) {
          throw new Error(`Could not delete ${path}; a session is still open.`, { cause: error });
        }
        throw error;
      }
    });
  }

  async clearSessions(): Promise<number> {
    return this.sessionSwaps.enqueue(async (setPhase) => {
      const sessions = await this.options.sessions.list();
      if (sessions.length === 0) {
        this.options.notifyChange();
        return 0;
      }
      const previousPath = this.options.sessions.activePath;
      await this.options.activation.prepareResources();
      this.commitSessionChange();
      this.options.activation.detachAgent();
      setPhase("loading");
      try {
        for (const session of sessions) await this.options.sessions.delete(session.path);
        await this.options.afterDelete?.();
        const { messages } = await this.options.sessions.create();
        setPhase("activating");
        await this.activateSession(messages);
        return sessions.length;
      } catch (error) {
        if (await this.recoverLiveSession(previousPath, setPhase)) {
          throw new Error("Could not clear sessions; a session is still open.", { cause: error });
        }
        throw error;
      }
    });
  }

  async renameSession(path: string, name: string): Promise<void> {
    await this.options.sessions.rename(path, name);
    this.options.sessions.refreshInfoIfActive();
    this.options.notifyChange();
  }

  /**
   * Rewind the transcript to just before conversation message `index`. Resolves
   * with the session token of the rewound conversation, so the caller can bind
   * its resend to it.
   */
  async truncateMessages(index: number): Promise<number> {
    // Captured at click time: a queued swap or a concurrent rewrite must fail
    // this rewind instead of applying it to a different transcript.
    const { expectedPath, expectedGeneration } = this.getBinding();
    const stale = (): boolean =>
      this.options.sessions.activePath !== expectedPath || this.options.sessions.generation !== expectedGeneration;
    return this.sessionSwaps.enqueue(async (setPhase) => {
      if (stale()) throw new Error("The session changed before the transcript could be rewound.");
      const agent = this.options.activation.currentAgent;
      if (!agent || agent.state.isStreaming) return this.getSessionToken();
      // `index` addresses the conversation transcript the UI renders, which excludes
      // pi's system-context message. Rewind the persisted conversation to that
      // index; the replacement agent re-seeds its own system message from the
      // current system prompt.
      const conversation = conversationMessages(agent.state.messages).slice(0, Math.max(0, index));
      await this.options.activation.prepareResources();
      if (stale()) throw new Error("The session changed before the transcript could be rewound.");
      const committed = this.commitSessionChange();
      setPhase("loading");
      const snapshot = await this.options.sessions.rewriteMessages(conversation, {
        expectedPath,
        expectedGeneration: committed,
      });
      setPhase("activating");
      this.options.activation.detachAgent();
      await this.options.activation.activate(snapshot.messages, { reloadResources: false });
      this.options.notifyChange();
      return committed;
    });
  }

  /**
   * Land a compacted transcript: persist it, then put it on the live agent.
   * Both steps are one queue operation, so a swap cannot slip between the
   * rewrite and the install. `binding` is the session the transcript was read
   * from; a swap, rewind, or other rewrite since then fails the commit before
   * it writes.
   *
   * When the install fails after the rewrite landed, the persisted transcript
   * is reloaded so the next turn does not continue from the stale one. If that
   * fails too, the commit rejects with {@link CompactionNotLiveError}.
   */
  async commitCompaction(messages: AgentMessage[], binding: SessionBinding): Promise<void> {
    await this.sessionSwaps.enqueue(async () => {
      await this.options.sessions.rewriteMessages(messages, binding);
      try {
        this.options.activation.installTranscript(messages);
      } catch (error) {
        if (!(await this.reloadPersistedTranscript())) throw new CompactionNotLiveError(error);
      }
      this.options.sessions.refreshInfoIfActive();
    });
    // Notify once the queue reports live again: a listener that reads the swap
    // state during the operation would see it as still loading.
    this.options.notifyChange();
  }

  /** Re-read the active session file onto a fresh agent. Runs inside a queue operation. */
  private async reloadPersistedTranscript(): Promise<boolean> {
    const { expectedPath, expectedGeneration } = this.getBinding();
    if (!expectedPath) return false;
    try {
      const snapshot = await this.options.sessions.load(expectedPath, { expectedPath, expectedGeneration });
      this.options.activation.installTranscript(snapshot.messages);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Recover from an active delete/clear that failed after detaching. Prefer the
   * session the user was in when it still exists (the delete itself failed),
   * then the most recent survivor, then a fresh session. Returns false when no
   * candidate could be activated, leaving recovery to {@link ensureSessionAgent}.
   */
  private async recoverLiveSession(
    previousPath: string | null,
    setPhase: (phase: "loading" | "activating") => void,
  ): Promise<boolean> {
    if (previousPath) {
      try {
        const { messages } = await this.options.sessions.load(previousPath);
        setPhase("activating");
        await this.activateSession(messages);
        return true;
      } catch {
        // The delete removed the previous file; fall through to a survivor.
      }
    }
    try {
      const { messages } = await this.options.sessions.continueRecent();
      setPhase("activating");
      await this.activateSession(messages);
      return true;
    } catch {
      // The recent session failed too; try a fresh one.
    }
    try {
      const { messages } = await this.options.sessions.create();
      setPhase("activating");
      await this.activateSession(messages);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reload the session that was active before a failed swap. Returns false
   * when there was no previous session or reloading it also fails; the caller
   * then leaves recovery to {@link ensureSessionAgent}.
   */
  private async restorePreviousSession(
    previousPath: string | null,
    setPhase: (phase: "loading" | "activating") => void,
  ): Promise<boolean> {
    if (!previousPath) return false;
    try {
      const { messages } = await this.options.sessions.load(previousPath);
      setPhase("activating");
      await this.activateSession(messages);
      return true;
    } catch {
      return false;
    }
  }

  private async loadIntoNewAgent(
    setPhase: (phase: "loading" | "activating") => void,
    load: () => Promise<ActiveSessionSnapshot>,
  ): Promise<void> {
    await this.options.activation.prepareResources();
    this.options.activation.detachAgent();
    setPhase("loading");
    const { messages } = await load();
    setPhase("activating");
    await this.activateSession(messages);
  }

  private async activateSession(messages: AgentMessage[]): Promise<void> {
    // Resources were reloaded before detaching on the swap path.
    await this.options.activation.activate(messages, { reloadResources: false });
    this.options.notifyChange();
  }
}
