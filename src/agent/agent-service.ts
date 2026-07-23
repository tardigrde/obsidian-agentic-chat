import { TFile, type App, type EventRef } from "obsidian";
import {
  type Agent,
  type AgentEvent,
  type AgentMessage,
  type Skill,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { type ImageContent, type Usage, type UserMessage } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import { activeModelId, apiKeyForProvider } from "../settings";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import { createObsidianFetcher, type WebFetcher } from "../tools/web-fetch";
import type { AskUserHandler } from "../tools/ask-user-tool";
import { createDynamicProxiedFetcher } from "../mcp/fetcher";
import { AgentObservabilityRuntime } from "../observability/agent-observability";
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
import { normalizeSteeringText, spendCapAbortReason, type TurnSteeringMode } from "./turn-control";
import { AgentTurnConfiguration } from "./turn-configuration";
import { AgentActiveSessionRuntime } from "./active-session-runtime";
import { ParentAgentRuntime } from "./parent-agent-runtime";
import { AgentParentConfigurationRuntime } from "./parent-agent-configuration";
import { AgentSessionLocalState } from "./session-local-state";
import { AgentToolCallController, type ToolApprovalRequest } from "./tool-call-controller";
import { AgentSessionEventRecorder } from "./session-event-recorder";
import { AgentActionAuditRecorder } from "./action-audit-log";
import { AgentFileCheckpointRecorder } from "./file-checkpoints";
import { AgentSessionActivation } from "./session-activation";
import { AgentSessionActions } from "./session-actions";
import { AgentCommandInvocationRuntime } from "./command-invocation";
import { AgentCompactionRuntime, type SummarizeFn } from "./compaction-runtime";
import { maybeCompactAgentTranscript } from "./compaction-orchestrator";
import { estimateContextUsage } from "./compaction";
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
import {
  runPlanTrackerCommand,
  type PlanTrackerCommandResult,
  type PlanTrackerState,
} from "./plan-tracker";
export type { ToolApprovalRequest } from "./tool-call-controller";

export type { SummarizeFn } from "./compaction-runtime";

export interface AgentServiceOptions {
  app: App;
  getSettings: () => AgenticChatSettings;
  sessionManager: ObsidianSessionManager;
  /** Resolve an "ask" approval gate; returns true to allow the tool call. */
  confirmToolCall: (request: ToolApprovalRequest) => Promise<boolean>;
  /** Injected for tests; production streams through the pi-ai Models runtime. */
  streamFn?: StreamFn;
  /** Injected for tests; production summarizes through the chat stream runtime. */
  summarize?: SummarizeFn;
  /** Injected for tests; production wraps Obsidian's `requestUrl` for the web tools. */
  webFetch?: WebFetcher;
  /** Injected for tests; production wraps Obsidian's `requestUrl` plus observability proxy settings. */
  observabilityFetch?: WebFetcher;
  /** Resolve an agent clarification question through the chat UI. */
  askUser?: AskUserHandler;
  /** Persist settings when runtime-managed credentials, such as MCP OAuth tokens, rotate. */
  saveSettings?: () => void | Promise<void>;
  /** Store large tool outputs so the transcript can reference them by id. */
  artifactStore?: ToolArtifactStoreLike;
}

export type ManualCompactionResult =
  | { compacted: true; beforeTokens: number; afterTokens: number; contextWindow: number }
  | { compacted: false; message: string };

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
  private readonly actionAudit: AgentActionAuditRecorder;
  private readonly observability: AgentObservabilityRuntime;
  private readonly fileCheckpoints: AgentFileCheckpointRecorder;
  private readonly sessionActivation: AgentSessionActivation;
  private readonly sessionActions: AgentSessionActions;
  private readonly compaction: AgentCompactionRuntime;
  private readonly artifactStore?: ToolArtifactStoreLike;
  private readonly turns: AgentTurnConfiguration;
  private readonly runtimeResources: AgentRuntimeResourceState;
  private readonly parentConfiguration: AgentParentConfigurationRuntime;
  private readonly parentAgent: ParentAgentRuntime;
  private readonly sessionState = new AgentSessionLocalState();
  private readonly listeners = new AgentServiceListeners();
  private readonly recentEvents: string[] = [];
  private readonly promptTurns: AgentPromptTurnRuntime;
  private readonly commandInvocations: AgentCommandInvocationRuntime;

  private initialization: Promise<void> | null = null;

  /** Vault `modify` listener that drops memoized reads when a file changes externally. */
  private vaultModifyRef?: EventRef;

  constructor(options: AgentServiceOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    const sessionManager = options.sessionManager;
    this.artifactStore = options.artifactStore;
    this.webFetch = options.webFetch ?? createDynamicProxiedFetcher(() => this.getSettings().network, createObsidianFetcher());
    this.sessions = new AgentActiveSessionRuntime(sessionManager, () => this.sessionDefaults());
    this.observability = new AgentObservabilityRuntime({
      getSettings: this.getSettings,
      fetcher:
        options.observabilityFetch ??
        createDynamicProxiedFetcher(() => this.effectiveObservabilityProxySettings(), createObsidianFetcher()),
      getSessionContext: () => ({
        sessionId: this.sessions.info?.id,
        sessionPath: this.sessions.activePath,
      }),
    });
    this.streams = new AgentStreamRuntime({
      getSettings: this.getSettings,
      streamFn: options.streamFn,
    });
    this.sessionEvents = new AgentSessionEventRecorder(sessionManager);
    this.turns = new AgentTurnConfiguration({ getSettings: this.getSettings });
    this.actionAudit = new AgentActionAuditRecorder({
      sessionManager,
      getContext: () => ({
        provider: this.getSettings().provider,
        modelId: this.getActiveModelId(),
        thinkingLevel: this.getActiveThinkingLevel(),
      }),
    });
    this.fileCheckpoints = new AgentFileCheckpointRecorder({ sessionManager });
    this.compaction = new AgentCompactionRuntime({
      getSettings: this.getSettings,
      sessionManager,
      buildStreamFn: () => this.streams.buildStreamFn(),
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
    this.toolCalls = new AgentToolCallController({
      app: this.app,
      getSettings: this.getSettings,
      confirmToolCall: options.confirmToolCall,
      getTools: () => this.agent?.state.tools ?? [],
      getProfiles: () => this.runtimeResources.current.profiles,
      onUndoApplied: () => this.notifyChange(),
      recordApproval: (input) => {
        this.observability.recordApproval(input);
        return this.actionAudit.recordApproval(input);
      },
      recordCheckpoint: (input) => this.actionAudit.recordCheckpoint(input),
      recordFileCheckpoint: (checkpoint) => this.fileCheckpoints.record(checkpoint),
    });
    this.subagents = new AgentSubagentRuntime({
      app: this.app,
      getSettings: this.getSettings,
      getResources: () => this.runtimeResources.current,
      buildStreamFn: () => this.streams.buildStreamFn(),
      recordUsage: (usage) => this.sessionState.recordSubagentUsage(usage),
      webFetch: this.webFetch,
      artifactStore: options.artifactStore,
      toolCalls: this.toolCalls,
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
      afterDelete: () => this.cleanupArtifactsAfterSessionDelete(),
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
    this.commandInvocations = new AgentCommandInvocationRuntime({
      getResources: () => this.runtimeResources.current,
      runPrompt: (prompt) => this.runPrompt((agent) => agent.prompt(prompt)),
      setError: (message) => this.setError(message),
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

  getPlanTracker(): PlanTrackerState | null {
    return this.sessions.getPlanTracker();
  }

  async runPlanTrackerCommand(input: string): Promise<PlanTrackerCommandResult> {
    await this.initialize();
    const result = runPlanTrackerCommand(this.sessions.getPlanTracker(), input);
    if (result.changed) {
      await this.sessions.savePlanTracker(result.state);
      this.notifyChange();
    }
    return result;
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
      toolBudget: this.runtimeResources.getToolBudgetSnapshot(),
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
      observabilityHealth: this.observability.getHealth(),
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

  async steerPrompt(prompt: string, images?: ImageContent[]): Promise<void> {
    await this.queueSteeringPrompt("steer", prompt, images);
  }

  async followUpPrompt(prompt: string, images?: ImageContent[]): Promise<void> {
    await this.queueSteeringPrompt("follow-up", prompt, images);
  }

  async redirectPrompt(prompt: string, images?: ImageContent[]): Promise<void> {
    await this.queueSteeringPrompt("redirect", prompt, images);
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
    return this.commandInvocations.invokeSkill(name, args);
  }

  private async cleanupArtifactsAfterSessionDelete(): Promise<void> {
    try {
      await this.artifactStore?.cleanupArtifacts?.();
    } catch (error) {
      console.warn(
        `Agentic Chat: artifact cleanup after session deletion failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** User-driven dispatch: ask the model to delegate a task to a named subagent. */
  async invokeAgent(name: string, task: string): Promise<void> {
    return this.commandInvocations.invokeAgent(name, task);
  }

  /**
   * `/init`: drive the agent to curate the vault's standing-instructions file
   * (AGENTS.md → CLAUDE.md → GEMINI.md). The agent reads the current file (if any)
   * and surveys the vault structure, then refines it with surgical `edit` calls —
   * each surfaces as a diff through the approval gate. `write` is used only to
   * create the file when none exists.
   */
  async invokeInit(instructions?: string): Promise<void> {
    return this.commandInvocations.invokeInit(instructions);
  }

  /** Persist a user-authored standing instruction through the normal tool/approval path. */
  async invokeInstruction(instruction: string): Promise<void> {
    return this.commandInvocations.invokeInstruction(instruction);
  }

  /** User-triggered compaction, optionally guided by instructions after `/compact`. */
  async compactNow(customInstructions?: string): Promise<ManualCompactionResult> {
    await this.initialize();
    if (this.requireAgent().state.isStreaming) {
      const message = "Wait for the agent to finish before compacting the conversation.";
      this.setError(message);
      return { compacted: false, message };
    }
    const agent = this.agent;
    if (!agent) return { compacted: false, message: "Nothing compacted. No active conversation is loaded." };
    const messages = agent.state.messages;
    const contextWindow = agent.state.model?.contextWindow ?? 0;
    const stats = {
      messageCount: messages.length,
      userTurns: messages.filter((message) => message.role === "user").length,
      estimatedTokens: estimateContextUsage(messages),
      contextWindow,
      hasInstructions: Boolean(customInstructions?.trim()),
    };
    const startEvent = {
      category: "compaction" as const,
      action: "start" as const,
      trigger: "manual" as const,
      timestamp: new Date().toISOString(),
      ...stats,
    };
    await this.actionAudit.record(startEvent);
    const result = await this.compaction.compactWithResult(messages, contextWindow, {
      force: true,
      customInstructions: customInstructions?.trim() || undefined,
    });
    if (result.status === "skipped") {
      await this.actionAudit.record({
        category: "compaction",
        action: "end",
        trigger: "manual",
        timestamp: new Date().toISOString(),
        status: "skipped",
        reason: result.reason,
        message: result.message,
        ...stats,
      });
      return { compacted: false, message: result.message };
    }
    this.sessionEvents.markPersistedMessages(result.messages);
    this.parentAgent.replace(result.messages);
    this.sessions.refreshInfoIfActive();
    this.notifyChange();
    // A successful compaction rewrites the session file, which drops audit
    // entries written before the rewrite. Re-record start so the final JSONL
    // still shows a complete start/end pair for the manual attempt.
    await this.actionAudit.record(startEvent);
    await this.actionAudit.record({
      category: "compaction",
      action: "end",
      trigger: "manual",
      timestamp: new Date().toISOString(),
      status: "compacted",
      replacementMessageCount: result.messages.length,
      ...stats,
    });
    return {
      compacted: true,
      beforeTokens: stats.estimatedTokens,
      afterTokens: estimateContextUsage(result.messages),
      contextWindow,
    };
  }

  abort(): void {
    const agent = this.agent;
    if (!agent) return;
    agent.clearAllQueues();
    agent.abort();
    void agent.waitForIdle().then(() => this.notifyChange());
  }

  async newSession(): Promise<void> {
    return this.sessionActions.newSession();
  }

  async continueRecentSession(): Promise<void> {
    return this.sessionActions.continueRecentSession();
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

  async clearSessions(): Promise<number> {
    return this.sessionActions.clearSessions();
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

  private async queueSteeringPrompt(mode: TurnSteeringMode, prompt: string, images?: ImageContent[]): Promise<void> {
    const text = normalizeSteeringText(prompt);
    if (!text) return;
    await this.initialize();
    const agent = this.requireAgent();
    const attached = images && images.length > 0 ? images : undefined;
    if (!agent.state.isStreaming) {
      await this.sendPrompt(text, attached);
      return;
    }

    const message = createUserMessage(text, attached);
    this.sessionState.clearError();
    if (mode === "follow-up") agent.followUp(message);
    else agent.steer(message);
    this.notifyChange();

    if (mode !== "redirect") return;
    agent.abort();
    await agent.waitForIdle();
    if (agent.hasQueuedMessages()) {
      await this.runPrompt((currentAgent) => currentAgent.continue());
    } else {
      this.notifyChange();
    }
  }

  private async initializeAgent(): Promise<void> {
    await this.sessionActions.continueRecentSession();
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    this.recordRecentEvent(event);
    this.observability.handleAgentEvent(event);
    await handleAgentRuntimeEvent(event, {
      recordMessageEnd: (message) => this.sessionEvents.recordMessageEnd(message),
      recordAgentEnd: (messages) => this.sessionEvents.recordAgentEnd(messages),
      recordAuditEvent: (agentEvent) => this.actionAudit.recordAgentEvent(agentEvent),
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

  private effectiveObservabilityProxySettings(): { proxyUrl: string; noProxy: string } {
    const settings = this.getSettings();
    return settings.observability.proxyUrl
      ? { proxyUrl: settings.observability.proxyUrl, noProxy: settings.observability.noProxy }
      : settings.network;
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

function createUserMessage(text: string, images?: ImageContent[]): UserMessage {
  const content: UserMessage["content"] = [{ type: "text", text }];
  if (images) content.push(...images);
  return { role: "user", content, timestamp: Date.now() };
}
