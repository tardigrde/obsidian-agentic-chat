import { TFile, type App, type EventRef } from "obsidian";
import {
  type Agent,
  type AgentEvent,
  type AgentMessage,
  type Skill,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { type ImageContent, type Usage } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import { activeModelId, apiKeyForProvider } from "../settings";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import { createObsidianFetcher, type WebFetcher } from "../tools/web-fetch";
import type { AskUserHandler } from "../tools/ask-user-tool";
import { createDynamicProxiedFetcher } from "../mcp/fetcher";
import { type ObsidianSessionManager, type SessionDefaults, type SessionInfo } from "../session/session-manager";
import { type AgentProfile } from "./subagents";
import { handleAgentRuntimeEvent } from "./agent-event-handler";
import type { RequestCostEstimate } from "./cost";
import {
  agentCompactionCount,
  agentContextFraction,
  agentNextCostEstimate,
  agentSessionUsage,
  agentSupportsImages,
} from "./service-readouts";
import { spendCapAbortReason } from "./turn-control";
import { AgentTurnConfiguration } from "./turn-configuration";
import { AgentActiveSessionRuntime } from "./active-session-runtime";
import { ParentAgentRuntime } from "./parent-agent-runtime";
import { AgentParentConfigurationRuntime } from "./parent-agent-configuration";
import { AgentSessionLocalState } from "./session-local-state";
import { AgentToolCallController, type ToolApprovalRequest } from "./tool-call-controller";
import { AgentSessionEventRecorder } from "./session-event-recorder";
import { AgentSessionActivation } from "./session-activation";
import { AgentSessionActions } from "./session-actions";
import {
  type AgentCommandPlan,
  resolveAgentCommand,
  resolveInitCommand,
  resolveSkillCommand,
} from "./command-dispatcher";
import { AgentCompactionRuntime, type SummarizeFn } from "./compaction-runtime";
import { maybeCompactAgentTranscript } from "./compaction-orchestrator";
import {
  AgentServiceListeners,
  type AgentServiceChangeListener,
  type AgentServiceEventListener,
} from "./service-listeners";
import { AgentStreamRuntime } from "./stream-runtime";
import { AgentRuntimeResourceState } from "./runtime-resource-state";
import { AgentSubagentRuntime } from "./subagent-runtime";
import { AgentPromptTurnRuntime, type PromptTurnRun } from "./prompt-turn-runtime";
import {
  buildRuntimeDiagnostics,
  MAX_RECENT_DIAGNOSTIC_EVENTS,
  summarizeAgentEvent,
  type AgentRuntimeDiagnostics,
} from "./diagnostics";
export type { ToolApprovalRequest } from "./tool-call-controller";

export type { SummarizeFn } from "./compaction-runtime";

export interface AgentServiceOptions {
  app: App;
  getSettings: () => AgenticChatSettings;
  sessionManager: ObsidianSessionManager;
  /** Resolve an "ask" approval gate; returns true to allow the tool call. */
  confirmToolCall: (request: ToolApprovalRequest) => Promise<boolean>;
  /** Injected for tests; production wraps pi-ai streamSimple. */
  streamFn?: StreamFn;
  /** Injected for tests; production summarizes via pi's `generateSummary`. */
  summarize?: SummarizeFn;
  /** Injected for tests; production wraps Obsidian's `requestUrl` for the web tools. */
  webFetch?: WebFetcher;
  /** Resolve an agent clarification question through the chat UI. */
  askUser?: AskUserHandler;
  /** Persist settings when runtime-managed credentials, such as MCP OAuth tokens, rotate. */
  saveSettings?: () => void | Promise<void>;
  /** Store large tool outputs so the transcript can reference them by id. */
  artifactStore?: ToolArtifactStoreLike;
}

/**
 * Owns the pi Agent for the chat view: model/tool/skill wiring, approval gates,
 * JSONL session persistence, and event/state fan-out to the UI.
 */
export class AgentService {
  private readonly app: App;
  private readonly getSettings: () => AgenticChatSettings;
  private readonly webFetch: WebFetcher;
  private readonly sessions: AgentActiveSessionRuntime;
  private readonly streams: AgentStreamRuntime;
  private readonly toolCalls: AgentToolCallController;
  private readonly subagents: AgentSubagentRuntime;
  private readonly sessionEvents: AgentSessionEventRecorder;
  private readonly sessionActivation: AgentSessionActivation;
  private readonly sessionActions: AgentSessionActions;
  private readonly compaction: AgentCompactionRuntime;
  private readonly turns: AgentTurnConfiguration;
  private readonly runtimeResources: AgentRuntimeResourceState;
  private readonly parentConfiguration: AgentParentConfigurationRuntime;
  private readonly parentAgent: ParentAgentRuntime;
  private readonly sessionState = new AgentSessionLocalState();
  private readonly listeners = new AgentServiceListeners();
  private readonly recentEvents: string[] = [];
  private readonly promptTurns: AgentPromptTurnRuntime;

  private initialization: Promise<void> | null = null;

  /** Vault `modify` listener that drops memoized reads when a file changes externally. */
  private vaultModifyRef?: EventRef;

  constructor(options: AgentServiceOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    const sessionManager = options.sessionManager;
    this.webFetch = options.webFetch ?? createDynamicProxiedFetcher(() => this.getSettings().network, createObsidianFetcher());
    this.sessions = new AgentActiveSessionRuntime(sessionManager, () => this.sessionDefaults());
    this.streams = new AgentStreamRuntime({
      getSettings: this.getSettings,
      streamFn: options.streamFn,
    });
    this.sessionEvents = new AgentSessionEventRecorder(sessionManager);
    this.turns = new AgentTurnConfiguration({ getSettings: this.getSettings });
    this.compaction = new AgentCompactionRuntime({
      getSettings: this.getSettings,
      sessionManager,
      summarize: options.summarize,
    });
    this.runtimeResources = new AgentRuntimeResourceState({
      app: this.app,
      getSettings: this.getSettings,
      readMemo: this.sessionState.readMemo,
      webFetch: this.webFetch,
      askUser:
        options.askUser ??
        (async () => {
          throw new Error("ask_user is unavailable because no chat UI handler is registered.");
        }),
      saveSettings: options.saveSettings,
      artifactStore: options.artifactStore,
    });
    this.subagents = new AgentSubagentRuntime({
      app: this.app,
      getSettings: this.getSettings,
      getResources: () => this.runtimeResources.current,
      buildStreamFn: () => this.streams.buildStreamFn(),
      recordUsage: (usage) => this.sessionState.recordSubagentUsage(usage),
    });
    this.toolCalls = new AgentToolCallController({
      app: this.app,
      getSettings: this.getSettings,
      confirmToolCall: options.confirmToolCall,
      getTools: () => this.agent?.state.tools ?? [],
      getProfiles: () => this.runtimeResources.current.profiles,
      onUndoApplied: () => this.notifyChange(),
    });
    this.parentConfiguration = new AgentParentConfigurationRuntime({
      getSettings: this.getSettings,
      streams: this.streams,
      turns: this.turns,
      runtimeResources: this.runtimeResources,
      subagents: this.subagents,
      toolCalls: this.toolCalls,
      sessions: this.sessions,
      onEvent: (event) => this.handleAgentEvent(event),
    });
    this.parentAgent = new ParentAgentRuntime(() => this.parentConfiguration.build());
    this.sessionActivation = new AgentSessionActivation({
      parentAgent: this.parentAgent,
      sessionEvents: this.sessionEvents,
      sessionState: this.sessionState,
      toolCalls: this.toolCalls,
      runtimeResources: this.runtimeResources,
    });
    this.sessionActions = new AgentSessionActions({
      sessions: this.sessions,
      activation: this.sessionActivation,
      notifyChange: () => this.notifyChange(),
    });
    this.promptTurns = new AgentPromptTurnRuntime({
      requireAgent: () => this.requireAgent(),
      getSettings: this.getSettings,
      hasApiKey: () => this.hasApiKey(),
      getSessionCostUsd: () => this.getSessionUsage().cost?.total ?? 0,
      refreshConfiguration: () => this.parentConfiguration.refresh(this.parentAgent),
      maybeCompact: () => this.maybeCompact(),
      clearError: () => this.sessionState.clearError(),
      setError: (error) => this.sessionState.setError(error),
      setErrorMessage: (message) => this.sessionState.setErrorMessage(message),
      consumeOverrides: () => this.turns.consumeOverrides(),
      notifyChange: () => this.notifyChange(),
    });
    // External edits change a file's contents out from under the agent; drop any
    // memoized read of it so the next read serves fresh content instead of a
    // stale "already read" pointer. Agent-driven writes invalidate via the tool.
    this.vaultModifyRef = this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) this.sessionState.invalidateRead(file.path);
    });
  }

  private get agent(): Agent | null {
    return this.parentAgent.current;
  }

  onEvent(listener: AgentServiceEventListener): () => void {
    return this.listeners.onEvent(listener);
  }

  onChange(listener: AgentServiceChangeListener): () => void {
    return this.listeners.onChange(listener);
  }

  getMessages(): AgentMessage[] {
    return this.agent?.state.messages ?? [];
  }

  isStreaming(): boolean {
    return this.agent?.state.isStreaming ?? false;
  }

  getError(): string | undefined {
    return this.sessionState.error ?? this.agent?.state.errorMessage;
  }

  getSessionInfo(): SessionInfo | undefined {
    return this.sessions.info;
  }

  getSkills(): Skill[] {
    return this.runtimeResources.getSkills();
  }

  /**
   * Set (or clear) a one-shot model override applied to the next prompt only,
   * then automatically reverted. A stepping stone to per-agent model routing.
   * Ignored for Ollama (the model id space is provider-specific).
   */
  setModelOverride(modelId: string | null): void {
    this.turns.setModelOverride(modelId);
    // Reflect the pending override in the chrome/estimate right away — but never
    // swap the model out from under an in-flight turn; refreshConfiguration will
    // pick it up before the next prompt.
    if (this.agent && !this.agent.state.isStreaming) {
      this.agent.state.model = this.turns.buildModelForTurn();
    }
    this.notifyChange();
  }

  /**
   * The pending one-shot model override, or null when none is queued. Reported
   * only for OpenRouter; other providers ignore the provider-specific override,
   * so the UI must too.
   */
  getModelOverride(): string | null {
    return this.turns.getModelOverride();
  }

  /** The model id the next prompt will actually use (override if queued, else settings). */
  getActiveModelId(): string {
    return this.turns.getActiveModelId();
  }

  /**
   * Set (or clear) a one-shot thinking level applied to the next prompt only, then
   * reverted — so effort can be raised for one hard prompt without changing the
   * saved default. Changing effort mid-conversation re-processes the prompt prefix
   * (a one-time cache miss); the composer knob's tooltip warns about that cost.
   */
  setThinkingOverride(level: ThinkingLevel | null): void {
    this.turns.setThinkingOverride(level);
    // Reflect the pending override in the chrome/estimate right away, but never
    // change the level out from under an in-flight turn.
    if (this.agent && !this.agent.state.isStreaming) {
      this.agent.state.thinkingLevel = this.turns.getActiveThinkingLevel();
    }
    this.notifyChange();
  }

  /** The pending one-shot thinking override, or null when none is queued. */
  getThinkingOverride(): ThinkingLevel | null {
    return this.turns.getThinkingOverride();
  }

  /** The thinking level the next prompt will actually use (override if queued, else settings). */
  getActiveThinkingLevel(): ThinkingLevel {
    return this.turns.getActiveThinkingLevel();
  }

  /**
   * Reasoning levels the active model actually supports, in UI order. Drives the
   * composer effort knob and `/effort` so the UI never offers a level (e.g.
   * `xhigh`) the current model can't take. Cached by model id so repeated UI
   * interactions (opening the picker, cycling effort) don't rebuild the model.
   */
  getActiveThinkingLevels(): ThinkingLevel[] {
    return this.turns.getActiveThinkingLevels();
  }

  getProfiles(): AgentProfile[] {
    return this.runtimeResources.getProfiles();
  }

  /**
   * Fraction (0–1) of the model's context window filled by the most recent turn.
   * Uses the last assistant turn's input tokens (the prompt pi sent that turn) as
   * a proxy for how full the next request will be. Undefined if unknown.
   */
  getContextFraction(): number | undefined {
    return agentContextFraction({ messages: this.getMessages(), model: this.agent?.state.model });
  }

  /** Sum token usage and cost across all assistant turns in the active session. */
  getSessionUsage(): Usage {
    return agentSessionUsage({
      messages: this.getMessages(),
      subagentUsage: this.sessionState.subagentUsage,
    });
  }

  /** Number of times this session has been auto-compacted (for one-shot UI notices). */
  getCompactionCount(): number {
    return agentCompactionCount({ messages: this.getMessages() });
  }

  getRuntimeDiagnostics(): AgentRuntimeDiagnostics {
    const settings = this.getSettings();
    return buildRuntimeDiagnostics({
      settings,
      sessionInfo: this.sessions.info,
      sessionPath: this.sessions.activePath,
      tools: this.agent?.state.tools ?? [],
      resources: this.runtimeResources.current,
      resourcesReloadedAt: this.runtimeResources.lastReloadAt,
      modelOverride: this.getModelOverride(),
      thinkingLevel: this.getActiveThinkingLevel(),
      thinkingOverride: this.getThinkingOverride(),
      isStreaming: this.isStreaming(),
      canUndo: this.canUndo(),
      lastError: this.getError(),
      contextFraction: this.getContextFraction(),
      compactionCount: this.getCompactionCount(),
      usage: this.getSessionUsage(),
      recentEvents: this.recentEvents,
    });
  }

  /**
   * Estimated size and cost of the next request (current transcript + assumed
   * output), for a pre-send readout. Undefined when the model has no pricing
   * (unknown model or local Ollama) so the UI can omit a meaningless "$0".
   */
  estimateNextCost(): RequestCostEstimate | undefined {
    const model = this.agent?.state.model;
    const settings = this.getSettings();
    // Include the system prompt (base + overlays + skills + subagents) so the
    // first-turn estimate isn't a large underestimate.
    return agentNextCostEstimate({
      messages: this.getMessages(),
      model,
      settings,
      systemPrompt: this.runtimeResources.composeSystemPrompt(settings, this.getActiveModelId()),
    });
  }

  /** Whether there's a captured vault change that {@link undoLastChange} can revert. */
  canUndo(): boolean {
    return this.toolCalls.canUndo();
  }

  async undoLastChange(): Promise<string> {
    return this.toolCalls.undoLastChange();
  }

  async initialize(): Promise<void> {
    if (this.agent) return;
    if (this.initialization) return this.initialization;
    this.initialization = this.initializeAgent();
    try {
      await this.initialization;
    } finally {
      this.initialization = null;
    }
  }

  async sendPrompt(prompt: string, images?: ImageContent[]): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const attached = images && images.length > 0 ? images : undefined;
    await this.runPrompt((agent) => agent.prompt(trimmed, attached));
  }

  /** Whether the model the next turn will use accepts image input (vision). */
  supportsImages(): boolean {
    return agentSupportsImages(this.agent?.state.model);
  }

  /**
   * Whether a vault-relative path is ignore-listed (invisible to the agent's
   * tools). Used by the composer so an attachment — especially the auto-attached
   * active note — in a private/ignored folder never leaks its contents into the
   * prompt; only a path-only reference (or nothing) is surfaced.
   */
  isPathIgnored(path: string): boolean {
    return this.runtimeResources.isPathIgnored(path);
  }

  async invokeSkill(name: string, args?: string): Promise<void> {
    return this.runCommandPlan(resolveSkillCommand(this.runtimeResources.current, name, args));
  }

  /** User-driven dispatch: ask the model to delegate a task to a named subagent. */
  async invokeAgent(name: string, task: string): Promise<void> {
    return this.runCommandPlan(resolveAgentCommand(this.runtimeResources.current, name, task));
  }

  /**
   * `/init`: drive the agent to curate the vault's standing-instructions file
   * (AGENTS.md → CLAUDE.md → GEMINI.md). The agent reads the current file (if any)
   * and surveys the vault structure, then refines it with surgical `edit` calls —
   * each surfaces as a diff through the approval gate. `write` is used only to
   * create the file when none exists.
   */
  async invokeInit(): Promise<void> {
    return this.runCommandPlan(resolveInitCommand());
  }

  abort(): void {
    const agent = this.agent;
    if (!agent) return;
    agent.abort();
    void agent.waitForIdle().then(() => this.notifyChange());
  }

  async newSession(): Promise<void> {
    return this.sessionActions.newSession();
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.sessionActions.listSessions();
  }

  async loadSession(path: string): Promise<void> {
    return this.sessionActions.loadSession(path);
  }

  async deleteSession(path: string): Promise<void> {
    return this.sessionActions.deleteSession(path);
  }

  async renameSession(path: string, name: string): Promise<void> {
    return this.sessionActions.renameSession(path, name);
  }

  /**
   * Rewind the conversation to just before message `index` (prompt editing): drop
   * that turn and everything after it, in memory and on disk, so the caller can
   * resend an edited prompt as a fresh branch.
   */
  async truncateMessages(index: number): Promise<void> {
    return this.sessionActions.truncateMessages(index);
  }

  dispose(): void {
    if (this.parentAgent.isDisposed) return;
    if (this.vaultModifyRef) this.app.vault.offref(this.vaultModifyRef);
    this.vaultModifyRef = undefined;
    this.parentAgent.dispose();
    this.listeners.clear();
  }

  private async runPrompt(run: PromptTurnRun): Promise<void> {
    await this.initialize();
    await this.promptTurns.run(run);
  }

  private async runCommandPlan(plan: AgentCommandPlan): Promise<void> {
    if (plan.type === "error") {
      this.setError(plan.message);
      return;
    }
    await this.runPrompt((agent) => agent.prompt(plan.prompt));
  }

  private async initializeAgent(): Promise<void> {
    await this.sessionActions.continueRecentSession();
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    this.recordRecentEvent(event);
    await handleAgentRuntimeEvent(event, {
      recordMessageEnd: (message) => this.sessionEvents.recordMessageEnd(message),
      recordAgentEnd: (messages) => this.sessionEvents.recordAgentEnd(messages),
      enforceSpendCap: () => this.enforceSpendCap(),
      setError: (error) => this.sessionState.setError(error),
      emitEvent: (agentEvent) => this.listeners.emitEvent(agentEvent),
      hasActiveSession: () => this.sessions.activePath !== null,
      refreshActiveSessionInfo: () => this.sessions.refreshInfoIfActive(),
      notifyChange: () => this.notifyChange(),
    });
  }

  /**
   * Hard spend cap: abort the in-flight run once this conversation's cost reaches
   * the cap, so a long tool-use turn can't blow past it. The pre-send check in
   * `runPrompt` stops new turns; this stops a turn already underway.
   */
  private enforceSpendCap(): void {
    const agent = this.agent;
    const reason = spendCapAbortReason({
      isStreaming: agent?.state.isStreaming ?? false,
      spendCapUsd: this.getSettings().notifications.costCapUsd,
      sessionCostUsd: this.getSessionUsage().cost?.total ?? 0,
    });
    if (!reason) return;
    this.sessionState.setErrorMessage(reason);
    agent?.abort();
  }

  /**
   * Auto-compaction: when the transcript fills past the configured threshold,
   * summarize the older turns into a single message and keep the recent ones, in
   * memory and on disk. Best-effort — any failure (no key, summary error, write
   * error) leaves the transcript untouched so a prompt is never lost.
   */
  private async maybeCompact(): Promise<void> {
    await maybeCompactAgentTranscript({
      getTranscript: () => {
        const agent = this.agent;
        if (!agent) return null;
        return {
          messages: agent.state.messages,
          contextWindow: agent.state.model?.contextWindow ?? 0,
        };
      },
      compact: (messages, contextWindow) => this.compaction.compact(messages, contextWindow),
      markPersistedMessages: (messages) => this.sessionEvents.markPersistedMessages(messages),
      replaceAgent: (messages) => this.parentAgent.replace(messages),
      refreshActiveSessionInfo: () => this.sessions.refreshInfoIfActive(),
      notifyChange: () => this.notifyChange(),
    });
  }

  private recordRecentEvent(event: AgentEvent): void {
    this.recentEvents.push(summarizeAgentEvent(event));
    if (this.recentEvents.length > MAX_RECENT_DIAGNOSTIC_EVENTS) {
      this.recentEvents.splice(0, this.recentEvents.length - MAX_RECENT_DIAGNOSTIC_EVENTS);
    }
  }

  private sessionDefaults(): SessionDefaults {
    const settings = this.getSettings();
    return {
      provider: settings.provider,
      modelId: activeModelId(settings),
      thinkingLevel: settings.thinkingLevel,
    };
  }

  private hasApiKey(): boolean {
    return !!apiKeyForProvider(this.getSettings(), this.getSettings().provider);
  }

  private requireAgent(): Agent {
    return this.parentAgent.requireAgent();
  }

  private setError(message: string): void {
    this.sessionState.setErrorMessage(message);
    this.notifyChange();
  }

  private notifyChange(): void {
    this.listeners.notifyChange();
  }
}
