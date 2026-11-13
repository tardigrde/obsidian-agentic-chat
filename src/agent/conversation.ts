import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  LoadSessionOptions,
  ObsidianSessionManager,
  SessionDefaults,
  SessionInfo,
} from "../session/session-manager";
import { conversationMessages } from "./conversation-messages";
import { createParentAgent, type ParentAgentHandle, type ParentAgentOptions } from "./parent-agent";

/** Everything the parent agent needs except the transcript it starts from. */
export type ParentAgentConfiguration = Omit<ParentAgentOptions, "messages">;

export interface ActiveSessionSnapshot {
  info: SessionInfo;
  messages: AgentMessage[];
}

export interface ActivateSessionOptions {
  reloadResources?: boolean;
}

/**
 * Session-local state that belongs to one transcript. The conversation resets
 * all of it whenever a different transcript goes live, so nothing from the
 * previous session (memoized reads, approvals, persisted-message markers) can
 * leak into the next one.
 */
export interface ConversationSessionState {
  sessionEvents: { markPersistedMessages(messages: AgentMessage[]): void };
  sessionState: { reset(): void };
  toolCalls: { clearSessionState(): void };
  runtimeResources: { clearSessionState(): void; reload(): Promise<unknown> };
}

export interface AgentConversationOptions extends ConversationSessionState {
  sessionManager: ObsidianSessionManager;
  /** Provider/model/thinking the session file should record. */
  getDefaults: () => SessionDefaults;
  /** The parent agent's current configuration (model, prompt, tools, hooks). */
  buildConfiguration: () => ParentAgentConfiguration;
  /** Injected for tests; production creates a pi parent agent. */
  createAgent?: (options: ParentAgentOptions) => ParentAgentHandle;
}

/**
 * The live conversation: which session file is active and which parent agent
 * holds its transcript. Every path that swaps, rewinds, compacts, or recovers
 * the transcript goes through here, so the session file, the agent, and the
 * session-local state cannot drift apart.
 */
export class AgentConversation {
  private agent: Agent | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private sessionInfo: SessionInfo | undefined;
  private readonly createAgent: (options: ParentAgentOptions) => ParentAgentHandle;

  constructor(private readonly options: AgentConversationOptions) {
    this.createAgent = options.createAgent ?? createParentAgent;
  }

  // ---------------------------------------------------------------------------
  // The parent agent
  // ---------------------------------------------------------------------------

  get currentAgent(): Agent | null {
    return this.agent;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  requireAgent(): Agent {
    if (!this.agent) throw new Error("Agent is not initialized.");
    return this.agent;
  }

  /**
   * Install `messages` on a fresh agent and mark them as already persisted.
   * Use it when the session file already holds exactly this transcript
   * (compaction, recovery). For a session swap use {@link activate}, which
   * also resets session-local state.
   */
  installTranscript(messages: AgentMessage[]): Agent | null {
    this.options.sessionEvents.markPersistedMessages(messages);
    return this.replaceAgent(messages);
  }

  /**
   * Stop the agent and drop it. Unsubscribe first so a late
   * message_end/agent_end cannot land in the next session's file.
   */
  detachAgent(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.agent?.abort();
    this.agent = null;
  }

  /** Detach for good; a disposed conversation never creates another agent. */
  dispose(): boolean {
    if (this.disposed) return false;
    this.disposed = true;
    this.detachAgent();
    return true;
  }

  /**
   * Reload vault-backed resources, then push the current configuration onto
   * the live agent and record it in the session file.
   */
  async refreshConfiguration(): Promise<void> {
    this.requireAgent();
    await this.options.runtimeResources.reload();
    this.applyConfiguration();
    await this.ensureConfiguration();
  }

  /** Push the current configuration onto the live agent without reloading resources. */
  applyConfiguration(): Agent {
    const agent = this.requireAgent();
    const configuration = this.options.buildConfiguration();
    agent.state.model = configuration.model;
    agent.state.thinkingLevel = configuration.thinkingLevel;
    agent.state.tools = configuration.tools;
    replaceSystemPrompt(agent, configuration.systemPrompt);
    return agent;
  }

  // ---------------------------------------------------------------------------
  // Session activation
  // ---------------------------------------------------------------------------

  /**
   * Reload vault-backed resources without touching the live agent or any
   * session-local state. A failed reload therefore leaves the previous session
   * fully usable instead of half-reset.
   */
  async prepareResources(): Promise<void> {
    await this.options.runtimeResources.reload();
  }

  /** Make `messages` the live transcript of a newly active session. */
  async activate(messages: AgentMessage[], options: ActivateSessionOptions = {}): Promise<void> {
    if (options.reloadResources !== false) await this.prepareResources();
    this.options.sessionEvents.markPersistedMessages(messages);
    this.options.sessionState.reset();
    this.options.toolCalls.clearSessionState();
    this.options.runtimeResources.clearSessionState();
    this.replaceAgent(messages);
  }

  // ---------------------------------------------------------------------------
  // The session file
  // ---------------------------------------------------------------------------

  get info(): SessionInfo | undefined {
    return this.sessionInfo;
  }

  get activePath(): string | null {
    return this.options.sessionManager.getActiveSessionPath();
  }

  get generation(): number {
    return this.options.sessionManager.getActiveSessionGeneration();
  }

  async continueRecent(): Promise<ActiveSessionSnapshot> {
    return this.snapshot(await this.options.sessionManager.continueRecentSession(this.options.getDefaults()));
  }

  async create(): Promise<ActiveSessionSnapshot> {
    return this.snapshot(await this.options.sessionManager.createSession(this.options.getDefaults()));
  }

  async load(path: string, options?: LoadSessionOptions): Promise<ActiveSessionSnapshot> {
    return this.snapshot(await this.options.sessionManager.loadSession(path, options));
  }

  async rewriteMessages(
    messages: AgentMessage[],
    options: { expectedPath?: string | null; expectedGeneration?: number } = {},
  ): Promise<ActiveSessionSnapshot> {
    await this.options.sessionManager.rewriteMessages(messages, options);
    return this.snapshot(this.options.sessionManager.getActiveSessionInfo());
  }

  async ensureConfiguration(): Promise<SessionInfo> {
    await this.options.sessionManager.ensureConfiguration(this.options.getDefaults());
    return this.refreshInfo();
  }

  list(): Promise<SessionInfo[]> {
    return this.options.sessionManager.listSessions();
  }

  async delete(path: string): Promise<void> {
    const activePath = this.activePath;
    await this.options.sessionManager.deleteSession(path);
    if (activePath === path) this.sessionInfo = undefined;
  }

  rename(path: string, name: string): Promise<void> {
    return this.options.sessionManager.renameSession(path, name);
  }

  refreshInfoIfActive(): SessionInfo | undefined {
    if (!this.options.sessionManager.hasActiveSession()) {
      this.sessionInfo = undefined;
      return undefined;
    }
    return this.refreshInfo();
  }

  private refreshInfo(): SessionInfo {
    this.sessionInfo = this.options.sessionManager.getActiveSessionInfo();
    return this.sessionInfo;
  }

  private snapshot(info: SessionInfo): ActiveSessionSnapshot {
    this.sessionInfo = info;
    return {
      info,
      messages: this.options.sessionManager.buildSessionContext().messages,
    };
  }

  /**
   * Install a conversation transcript on a fresh agent.
   *
   * Any system message in `messages` is dropped: pi 1.0.0 seeds its own leading
   * system message from `initialState.systemPrompt`, and it only does so when
   * the transcript does not already start with one. Passing a persisted system
   * message through would therefore keep a stale prompt in force for the whole
   * session instead of the freshly composed one.
   *
   * The previous agent is unsubscribed but not aborted: a replacement swaps
   * the transcript of an idle conversation, and {@link detachAgent} is the
   * stop path.
   */
  private replaceAgent(messages: AgentMessage[]): Agent | null {
    if (this.disposed) return null;
    const conversation = conversationMessages(messages);
    this.unsubscribe?.();
    const handle = this.createAgent({ ...this.options.buildConfiguration(), messages: conversation });
    this.agent = handle.agent;
    this.unsubscribe = handle.unsubscribe;
    return this.agent;
  }
}

/**
 * Swap the agent's system prompt.
 *
 * pi 1.0.0 makes `state.systemPrompt` read-only: the prompt is replayed from the
 * transcript's system messages, and mid-conversation changes are made by
 * appending a system message rather than mutating state. Refreshing config on a
 * live agent must replace the prompt outright, not append a delta, so rewrite
 * the leading system message's `content`. Its `toolsAdded` is left alone because
 * tool changes are declared separately by assigning `state.tools`, which the
 * agent loop diffs and announces itself.
 *
 * The parent always gets a non-empty prompt (`buildSystemPrompt` falls back to
 * `DEFAULT_SYSTEM_PROMPT`), so pi always seeds a leading system message.
 */
function replaceSystemPrompt(agent: Agent, systemPrompt: string): void {
  const messages = agent.state.messages;
  const first = messages[0];
  if (!first || first.role !== "system" || first.content === systemPrompt) return;
  agent.state.messages = [{ ...first, content: systemPrompt }, ...messages.slice(1)];
}
