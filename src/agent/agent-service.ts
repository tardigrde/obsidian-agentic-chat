import { TFile, Notice, type App, type EventRef } from "obsidian";
import {
  type Agent,
  type AgentEvent,
  type AgentMessage,
  type StreamFn,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Skill } from "../skills/skill-prompt";
import { type ImageContent, type Usage, type UserMessage } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings-schema";
import { activeModelId, apiKeyForProvider } from "../settings-schema";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import { effectiveProxy } from "../network/proxy";
import { createObsidianFetcher, type WebFetcher } from "../tools/web-fetch";
import type { AskUserHandler } from "../tools/ask-user-tool";
import type { SkillScaffolder } from "../tools/skill-tools";
import { createDynamicProxiedFetcher } from "../mcp/fetcher";
import { AgentObservabilityRuntime } from "../observability/agent-observability";
import { errorMessage } from "../utils/errors";
import { type ObsidianSessionManager, type SessionDefaults, type SessionInfo } from "../session/session-manager";
import { type AgentRole } from "./subagents";
import { handleAgentRuntimeEvent } from "./agent-event-handler";
import type { RequestCostEstimate } from "./cost";
import {
  agentCompactionCount,
  agentContextOverheadTokens,
  agentContextReadout,
  agentNextCostEstimate,
  agentSessionUsage,
  agentSupportsImages,
} from "./service-readouts";
import { CachedContextOverheadCounter, type ContextReadout } from "./readouts";
import { normalizeSteeringText, spendCapAbortReason } from "./turn-control";
import { AgentTurnConfiguration } from "./turn-configuration";
import { AgentConversation } from "./conversation";
import { AgentParentConfigurationRuntime } from "./parent-agent-configuration";
import { AgentSessionLocalState } from "./session-local-state";
import { AgentToolCallController, type ToolApprovalRequest, type UserApprovalChoice } from "./tool-call-controller";
import { AgentSessionEventRecorder } from "./session-event-recorder";
import { AgentActionAuditRecorder } from "./action-audit-log";
import { AgentFileCheckpointRecorder } from "./file-checkpoints";
import { AgentSessionActions } from "./session-actions";
import {
  type AgentCommandPlan,
  resolveAgentCommand,
  resolveInitCommand,
  resolveInstructionCommand,
  resolveSkillCommand,
} from "./command-dispatcher";
import { AgentCompactionRuntime, type AgentCompactionRunResult, type SummarizeFn } from "./compaction-runtime";
import { maybeCompactAgentTranscript } from "./compaction-orchestrator";
import { estimateContextUsage } from "./compaction";
import { conversationMessages } from "./conversation-messages";
import {
  AgentServiceListeners,
  type AgentServiceChangeListener,
  type AgentServiceEventListener,
} from "./service-listeners";
import { AgentStreamRuntime } from "./stream-runtime";
import { AgentLoopGuard } from "./loop-guard";
import { AgentTurnCap, CHILD_TURN_CAP } from "./turn-cap";
import { buildStopNoticeMessage, type StopNoticeModel } from "./stop-notice";
import { AgentRuntimeResourceState } from "./runtime-resource-state";
import type { AgentRuntimeResources } from "./runtime-resources";
import { AgentSubagentRuntime } from "./subagent-runtime";
import { AgentPromptTurnRuntime, SESSION_CHANGED_MESSAGE, type PromptTurnRun } from "./prompt-turn-runtime";
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
  /** Resolve an "ask" approval gate; returns the user's decision. */
  confirmToolCall: (request: ToolApprovalRequest, signal?: AbortSignal) => Promise<UserApprovalChoice>;
  /** Injected for tests; production streams through the pi-ai Models runtime. */
  streamFn?: StreamFn;
  /**
   * Disable the loop guard for scripted e2e runs: the guard would soft-stop a
   * scripted stream that repeats an identical tool batch, failing the spec
   * with an unrelated-looking transcript divergence.
   */
  loopGuardDisabled?: boolean;
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
  /** Backs the agent `create_skill` tool with the New skill wizard writer. Omitted in tests without a vault. */
  skillScaffolder?: SkillScaffolder;
}

export type ManualCompactionResult =
  | { compacted: true; beforeTokens: number; afterTokens: number; contextWindow: number }
  | { compacted: false; message: string };

/**
 * Owns the pi Agent for the chat view: model/tool/skill wiring, approval gates,
 * JSONL session persistence, and event/state fan-out to the UI.
 */
/** No-op loop guard used for scripted e2e runs (see `AgentServiceOptions.loopGuardDisabled`). */
const DISABLED_LOOP_GUARD: Pick<AgentLoopGuard, "finishTurn"> = {
  finishTurn: () => undefined,
};

export class AgentService {
  private readonly app: App;
  private readonly getSettings: () => AgenticChatSettings;
  private readonly webFetch: WebFetcher;
  private readonly conversation: AgentConversation;
  private readonly streams: AgentStreamRuntime;
  private readonly toolCalls: AgentToolCallController;
  private readonly subagents: AgentSubagentRuntime;
  private readonly sessionEvents: AgentSessionEventRecorder;
  private readonly actionAudit: AgentActionAuditRecorder;
  private readonly observability: AgentObservabilityRuntime;
  private readonly fileCheckpoints: AgentFileCheckpointRecorder;
  private readonly sessionActions: AgentSessionActions;
  private readonly compaction: AgentCompactionRuntime;
  private readonly artifactStore?: ToolArtifactStoreLike;
  private readonly turns: AgentTurnConfiguration;
  private readonly runtimeResources: AgentRuntimeResourceState;
  private readonly parentConfiguration: AgentParentConfigurationRuntime;
  private readonly sessionState = new AgentSessionLocalState();
  private readonly listeners = new AgentServiceListeners();
  private readonly loopGuard = new AgentLoopGuard();
  private readonly turnCap = new AgentTurnCap({ maxTurns: () => this.getSettings().maxTurnsPerPrompt });
  private readonly recentEvents: string[] = [];
  private readonly promptTurns: AgentPromptTurnRuntime;

  private initialization: Promise<void> | null = null;
  /** Set when a compaction rewrite landed but the live transcript is stale. */
  private compactionRecoveryError: string | undefined;
  /** Memoizes system-prompt and tool-schema token counts for the per-event readout. */
  private readonly contextOverhead = new CachedContextOverheadCounter();

  /** Vault `modify` listener that drops memoized reads when a file changes externally. */
  private vaultModifyRef?: EventRef;

  constructor(options: AgentServiceOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    const sessionManager = options.sessionManager;
    this.artifactStore = options.artifactStore;
    this.webFetch = options.webFetch ?? createDynamicProxiedFetcher(() => this.getSettings().network, createObsidianFetcher());
    this.observability = new AgentObservabilityRuntime({
      getSettings: this.getSettings,
      fetcher:
        options.observabilityFetch ??
        createDynamicProxiedFetcher(() => this.effectiveObservabilityProxySettings(), createObsidianFetcher()),
      getSessionContext: () => ({
        sessionId: this.conversation.info?.id,
        sessionPath: this.conversation.activePath,
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
      skillScaffolder: options.skillScaffolder,
    });
    this.subagents = new AgentSubagentRuntime({
      app: this.app,
      getSettings: this.getSettings,
      getResources: () => this.runtimeResources.current,
      buildStreamFn: () => this.streams.buildStreamFn(),
      recordUsage: (usage) => this.sessionState.recordSubagentUsage(usage),
      webFetch: this.webFetch,
      artifactStore: options.artifactStore,
      // Deferred: the controller is constructed next and shares this runtime's registry.
      toolCalls: {
        beforeToolCall: (context, signal) => this.toolCalls.beforeToolCall(context, signal),
        afterToolCall: (context) => this.toolCalls.afterToolCall(context),
      },
      createTurnCap: () => new AgentTurnCap({ maxTurns: CHILD_TURN_CAP }),
    });
    this.toolCalls = new AgentToolCallController({
      app: this.app,
      getSettings: this.getSettings,
      confirmToolCall: options.confirmToolCall,
      getTools: () => this.agent?.state.tools ?? [],
      getProfiles: () => this.runtimeResources.current.profiles,
      onUndoApplied: () => this.notifyChange(),
      onStopRequested: () => this.abort(),
      recordApproval: (input) => {
        this.observability.recordApproval(input);
        return this.actionAudit.recordApproval(input);
      },
      recordCheckpoint: (input) => this.actionAudit.recordCheckpoint(input),
      recordFileCheckpoint: (checkpoint) => this.fileCheckpoints.record(checkpoint),
      subagentRegistry: this.subagents.registry,
    });
    this.conversation = new AgentConversation({
      sessionManager,
      getDefaults: () => this.sessionDefaults(),
      // Deferred: the configuration runtime is constructed next and reads this conversation's session id.
      buildConfiguration: () => this.parentConfiguration.build(),
      sessionEvents: this.sessionEvents,
      sessionState: this.sessionState,
      toolCalls: this.toolCalls,
      runtimeResources: this.runtimeResources,
    });
    this.parentConfiguration = new AgentParentConfigurationRuntime({
      getSettings: this.getSettings,
      streams: this.streams,
      turns: this.turns,
      runtimeResources: this.runtimeResources,
      subagents: this.subagents,
      toolCalls: this.toolCalls,
      loopGuard: options.loopGuardDisabled ? DISABLED_LOOP_GUARD : this.loopGuard,
      turnCap: this.turnCap,
      sessions: this.conversation,
      onEvent: (event) => this.handleAgentEvent(event),
    });
    this.sessionActions = new AgentSessionActions({
      sessions: this.conversation,
      activation: this.conversation,
      notifyChange: () => this.notifyChange(),
      afterDelete: () => this.cleanupArtifactsAfterSessionDelete(),
    });
    this.promptTurns = new AgentPromptTurnRuntime({
      conversation: this.conversation,
      errors: this.sessionState,
      getSettings: this.getSettings,
      hasApiKey: () => this.hasApiKey(),
      getSessionCostUsd: () => this.getSessionUsage().cost?.total ?? 0,
      maybeCompact: () => this.maybeCompact(),
      afterCompaction: () => this.compactionRecoveryError,
      sessionToken: () => this.sessionActions.getSessionToken(),
      onTurnStart: () => this.toolCalls.clearStopRequested(),
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
    return this.conversation.currentAgent;
  }

  onEvent(listener: AgentServiceEventListener): () => void {
    return this.listeners.onEvent(listener);
  }

  onChange(listener: AgentServiceChangeListener): () => void {
    return this.listeners.onChange(listener);
  }

  /**
   * The conversation transcript, without pi's system-context message.
   *
   * pi 1.0.0 seeds a leading `system` message into `agent.state.messages`
   * carrying the system prompt and tool declarations. That is runtime context,
   * not conversation: exposing it here would leak the whole prompt and tool
   * schemas into the UI, session persistence, and the export path.
   */
  getMessages(): AgentMessage[] {
    return conversationMessages(this.agent?.state.messages ?? []);
  }

  isStreaming(): boolean {
    return this.agent?.state.isStreaming ?? false;
  }

  /** Whether a prompt turn is starting or running, including the pre-stream window. */
  isTurnInFlight(): boolean {
    return this.promptTurns.isInFlight() || this.isStreaming();
  }

  /** Stop one subagent dispatched by this service; other services are untouched. */
  abortSubagentChild(id: string): void {
    this.subagents.abortChild(id);
  }

  getError(): string | undefined {
    return this.sessionState.error ?? this.agent?.state.errorMessage;
  }

  getSessionInfo(): SessionInfo | undefined {
    return this.conversation.info;
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

  /** The thinking level the next prompt will actually use (clamped to the active model). */
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

  getProfiles(): AgentRole[] {
    return this.runtimeResources.getProfiles();
  }

  /**
   * Section-by-section estimate of the next request's context load. Includes the
   * composed system prompt (with loaded skill bodies), active tool schemas, and
   * the response reserve, so the context bar matches what the model receives.
   * Undefined when the model or its context window is unknown.
   */
  getContextReadout(): ContextReadout | undefined {
    const settings = this.getSettings();
    const model = this.agent?.state.model;
    if (!model) return undefined;
    return agentContextReadout({
      messages: this.getMessages(),
      model,
      settings,
      systemPrompt: this.runtimeResources.composeSystemPrompt(settings, this.getActiveModelId()),
      tools: this.agent?.state.tools ?? [],
    }, this.contextOverhead);
  }

  /**
   * Non-transcript load (system prompt, tool schemas, response reserve), measured
   * exactly as {@link getContextReadout} does so compaction and the bar agree.
   */
  private getContextOverheadTokens(): number {
    const settings = this.getSettings();
    return agentContextOverheadTokens({
      settings,
      systemPrompt: this.runtimeResources.composeSystemPrompt(settings, this.getActiveModelId()),
      tools: this.agent?.state.tools ?? [],
    }, this.contextOverhead);
  }

  /** Fraction (0–1) of the model's context window the next request will occupy. */
  getContextFraction(): number | undefined {
    return this.getContextReadout()?.fraction;
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

  /**
   * Re-read vault-backed runtime resources (plugins, skills, roles, MCP
   * servers) so diagnostics and the next turn reflect the current vault.
   */
  async reloadRuntimeResources(): Promise<AgentRuntimeResources> {
    return this.runtimeResources.reload();
  }

  getRuntimeDiagnostics(): AgentRuntimeDiagnostics {
    const settings = this.getSettings();
    return buildRuntimeDiagnostics({
      settings,
      sessionInfo: this.conversation.info,
      sessionPath: this.conversation.activePath,
      tools: this.agent?.state.tools ?? [],
      resources: this.runtimeResources.current,
      resourcesReloadedAt: this.runtimeResources.lastReloadAt,
      toolBudget: this.runtimeResources.getToolBudgetSnapshot(),
      modelOverride: this.getModelOverride(),
      contextWindow: this.turns.buildModelForTurn().contextWindow || null,
      thinkingLevel: this.getActiveThinkingLevel(),
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
   * Estimated size and cost of the next request (transcript + composed system
   * prompt + active tool schemas + assumed output), for a pre-send readout.
   * Undefined when the model has no pricing (unknown model or local Ollama) so
   * the UI can omit a meaningless "$0".
   */
  estimateNextCost(): RequestCostEstimate | undefined {
    const model = this.agent?.state.model;
    const settings = this.getSettings();
    // Count the full next request, not just the transcript: the first-turn
    // estimate used to include only the system prompt, and never the tools.
    return agentNextCostEstimate({
      messages: this.getMessages(),
      model,
      settings,
      systemPrompt: this.runtimeResources.composeSystemPrompt(settings, this.getActiveModelId()),
      tools: this.agent?.state.tools ?? [],
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
    // Join the swap queue before checking the agent: a send that arrives while
    // another session is loading must wait for that swap, not start on the old
    // agent. A failed swap rejects until a later swap recovers it.
    await this.sessionActions.waitForLive();
    if (this.agent) return;
    if (this.initialization) return this.initialization;
    this.initialization = this.sessionActions.ensureSessionAgent();
    try {
      await this.initialization;
    } finally {
      this.initialization = null;
    }
  }

  async sendPrompt(prompt: string, images?: ImageContent[], expectedSessionToken?: string): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const attached = images && images.length > 0 ? images : undefined;
    await this.runPrompt((agent) => agent.prompt(trimmed, attached), expectedSessionToken);
  }

  /** Session path + explicit operation epoch, for stale-send guards. */
  getSessionToken(): string {
    return this.sessionActions.getSessionToken();
  }

  /** Surface the shared stale-session message without starting a turn. */
  reportSessionChanged(): void {
    this.setError(SESSION_CHANGED_MESSAGE);
  }

  /**
   * Deliver text into the active turn. pi drains its steering queue after the
   * current model turn, or the run ends and takeUndeliveredSteers returns it.
   * When the agent is idle, the same call sends the text as a normal prompt.
   */
  async steerPrompt(prompt: string, images?: ImageContent[], expectedSessionToken?: string): Promise<void> {
    const text = normalizeSteeringText(prompt);
    if (!text) return;
    await this.initialize();
    if (expectedSessionToken !== undefined && this.getSessionToken() !== expectedSessionToken) {
      this.reportSessionChanged();
      return;
    }
    const attached = images && images.length > 0 ? images : undefined;
    const agent = this.requireAgent();
    if (!agent.state.isStreaming) {
      await this.sendPrompt(text, attached, expectedSessionToken);
      return;
    }

    const message = createUserMessage(text, attached);
    this.sessionState.clearError();
    // Steering is user input too: user-provided info ends any running streak.
    this.resetTurnGuards();
    agent.steer(message);
    this.notifyChange();
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

  private async cleanupArtifactsAfterSessionDelete(): Promise<void> {
    try {
      await this.artifactStore?.cleanupArtifacts?.();
    } catch (error) {
      console.warn(
        `Agentic Chat: artifact cleanup after session deletion failed: ${
          errorMessage(error)
        }`,
      );
    }
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
  async invokeInit(instructions?: string): Promise<void> {
    return this.runCommandPlan(resolveInitCommand(instructions));
  }

  /** Persist a user-authored standing instruction through the normal tool/approval path. */
  async invokeInstruction(instruction: string): Promise<void> {
    return this.runCommandPlan(resolveInstructionCommand(instruction));
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
    // Compact the conversation only. pi's system message stays as agent state,
    // and the replacement agent re-seeds it from the current system prompt.
    const messages = conversationMessages(agent.state.messages);
    const sessionToken = this.sessionActions.getSessionToken();
    const expectedPath = this.conversation.activePath;
    const expectedGeneration = this.conversation.generation;
    const contextWindow = agent.state.model?.contextWindow ?? 0;
    const overheadTokens = this.getContextOverheadTokens();
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
    if (this.sessionActions.getSessionToken() !== sessionToken) {
      return {
        compacted: false,
        message: "Nothing compacted. The active session changed before compaction started.",
      };
    }
    let result: AgentCompactionRunResult;
    try {
      result = await this.compaction.compactWithResult(messages, contextWindow, {
        force: true,
        overheadTokens,
        customInstructions: customInstructions?.trim() || undefined,
        expectedPath,
        expectedGeneration,
      });
    } catch (error) {
      // A session change during summarization cancels the rewrite. Report it as
      // a normal manual-compaction result so `/compact` does not throw.
      const message =
        `Nothing compacted. The active session changed while compacting: ${
          errorMessage(error)
        }`;
      return { compacted: false, message };
    }
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
    // The audit await above (and summarization) can outlive the session. Never
    // install a transcript from A into the agent that now holds B.
    if (this.sessionActions.getSessionToken() !== sessionToken) {
      return {
        compacted: false,
        message: "Nothing compacted. The active session changed while compacting.",
      };
    }
    // The saved session is already rewritten at this point. If the live agent
    // cannot be replaced, report it instead of pretending compaction succeeded.
    try {
      this.installCompactedTranscript(result.messages);
    } catch (error) {
      if (!(await this.recoverCompactedSession())) {
        const detail = errorMessage(error);
        const message =
          `Compaction rewrote the saved session, but the live conversation could not be replaced: ${detail}. ` +
          "Reload the session to continue from the compacted transcript.";
        this.setError(message);
        return { compacted: false, message };
      }
    }
    // Audit events live in the append-only sidecar, so the rewrite above no
    // longer drops the start event. Record only the matching end event.
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
      // Report the same load the context bar shows: transcript plus overhead.
      beforeTokens: stats.estimatedTokens + overheadTokens,
      afterTokens: estimateContextUsage(result.messages) + overheadTokens,
      contextWindow,
    };
  }

  abort(): void {
    const agent = this.agent;
    if (!agent) return;
    this.stopAgent(agent);
    void agent.waitForIdle().then(() => this.notifyChange());
  }

  /**
   * One stop policy for every path that ends a turn early: clear the queues
   * first, then abort, so a queued message cannot drain into the next run. The
   * cleared text goes back to the composer, which emptied it on steer.
   */
  private stopAgent(agent: Agent): void {
    this.takeQueuedMessages(agent);
    agent.abort();
  }

  async newSession(): Promise<void> {
    this.resetTurnGuards();
    return this.sessionActions.newSession();
  }

  async continueRecentSession(): Promise<void> {
    return this.sessionActions.continueRecentSession();
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.sessionActions.listSessions();
  }

  async loadSession(path: string): Promise<void> {
    this.resetTurnGuards();
    return this.sessionActions.loadSession(path);
  }

  /** Inspectable session-swap state for diagnostics and tests. */
  getSessionSwapState(): ReturnType<AgentSessionActions["getSwapState"]> {
    return this.sessionActions.getSwapState();
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
    this.resetTurnGuards();
    return this.sessionActions.truncateMessages(index);
  }

  dispose(): void {
    if (this.conversation.isDisposed) return;
    if (this.vaultModifyRef) this.app.vault.offref(this.vaultModifyRef);
    this.vaultModifyRef = undefined;
    this.conversation.dispose();
    this.listeners.clear();
  }

  private async runPrompt(run: PromptTurnRun, expectedSessionToken?: string): Promise<void> {
    this.compactionRecoveryError = undefined;
    await this.initialize();
    // A fresh prompt starts a new epoch: neither the identical-batch streak nor
    // the turn budget from a previous user turn carries into this one.
    this.resetTurnGuards();
    await this.promptTurns.run(this.settlingQueues(run), expectedSessionToken);
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    this.recordRecentEvent(event);
    this.observability.handleAgentEvent(event);
    await handleAgentRuntimeEvent(event, {
      recordMessageEnd: (message) => this.sessionEvents.recordMessageEnd(message),
      recordAgentEnd: async (messages) => {
        // Persist the run first so a guard-message failure can never drop the
        // transcript; the guard note is appended after, never injected mid-context.
        await this.sessionEvents.recordAgentEnd(messages);
        try {
          await this.emitTurnGuardMessage();
        } catch {
          // UI/persist for the synthetic note is best-effort — the run above won.
        }
      },
      recordAuditEvent: (agentEvent) => this.actionAudit.recordAgentEvent(agentEvent),
      enforceSpendCap: () => this.enforceSpendCap(),
      setError: (error) => this.sessionState.setError(error),
      emitEvent: (agentEvent) => this.listeners.emitEvent(agentEvent),
      hasActiveSession: () => this.conversation.activePath !== null,
      refreshActiveSessionInfo: () => this.conversation.refreshInfoIfActive(),
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
    if (agent) this.stopAgent(agent);
  }

  /**
   * When the loop guard or the turn cap fired, append the plain-text
   * explanation at the end of the transcript (JSONL + chat bubble) plus a
   * transient Notice. The message is transcript-only: the parent agent's
   * `convertToLlm` drops it, so the model never reads text it did not write
   * (#283). The loop-guard notice wins when both fired in the
   * same turn, so the user never gets two stop notes. Runs once per fire — each
   * guard clears its notice on the next prompt.
   */
  private async emitTurnGuardMessage(): Promise<void> {
    const text = this.loopGuard.noticeText ?? this.turnCap.noticeText;
    if (!text) return;
    const message = buildStopNoticeMessage(text, this.agent?.state.model as StopNoticeModel | undefined);
    // Keep it in the live transcript so the UI and replay match; toLlmMessages
    // filters it out of every model request.
    this.agent?.state.messages.push(message);
    await this.sessionEvents.recordMessageEnd(message);
    this.listeners.emitEvent({ type: "message_start", message });
    this.listeners.emitEvent({ type: "message_end", message });
    try {
      new Notice(text);
    } catch {
      // Headless tests / no DOM — chat bubble above already carries the note.
    }
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
        // Compact the conversation only; pi's system message is agent state and
        // is re-seeded from the current prompt when the agent is replaced.
        return {
          messages: conversationMessages(agent.state.messages),
          contextWindow: agent.state.model?.contextWindow ?? 0,
          overheadTokens: this.getContextOverheadTokens(),
        };
      },
      compact: (messages, contextWindow, overheadTokens) =>
        this.compaction.compact(messages, contextWindow, { overheadTokens }),
      install: (messages) => this.installCompactedTranscript(messages),
      recoverAfterReplaceFailure: () => this.recoverCompactedSession(),
      onCompactionFailure: (_error, persisted) => {
        if (!persisted) return;
        this.compactionRecoveryError =
          "Compaction rewrote the saved session, but the live conversation could not be replaced. " +
          "Reload the session to continue from the compacted transcript.";
        this.setError(this.compactionRecoveryError);
      },
    });
  }

  /**
   * Re-read the active session after a successful compaction rewrite whose live
   * replacement failed, so the next turn continues from the persisted summary
   * instead of a stale in-memory transcript.
   */
  private async recoverCompactedSession(): Promise<boolean> {
    const path = this.conversation.activePath;
    const expectedGeneration = this.conversation.generation;
    if (!path) return false;
    try {
      // Bind the reload to the session that failed to replace. A user switch
      // during the read must win instead of being overwritten by recovery.
      const snapshot = await this.conversation.load(path, {
        expectedPath: path,
        expectedGeneration,
      });
      this.installCompactedTranscript(snapshot.messages);
      return true;
    } catch {
      return false;
    }
  }

  private recordRecentEvent(event: AgentEvent): void {
    this.recentEvents.push(summarizeAgentEvent(event));
    if (this.recentEvents.length > MAX_RECENT_DIAGNOSTIC_EVENTS) {
      this.recentEvents.splice(0, this.recentEvents.length - MAX_RECENT_DIAGNOSTIC_EVENTS);
    }
  }

  private effectiveObservabilityProxySettings(): { proxyUrl: string; noProxy: string } {
    const settings = this.getSettings();
    return effectiveProxy(settings.observability, settings.network);
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
    return this.conversation.requireAgent();
  }

  /**
   * Install a transcript the session file already holds (a compaction rewrite
   * or a reload after one), then publish the new session info.
   */
  private installCompactedTranscript(messages: AgentMessage[]): void {
    this.conversation.installTranscript(messages);
    this.conversation.refreshInfoIfActive();
    this.notifyChange();
  }

  /** Neither the identical-batch streak nor the turn budget survives new user input or a session change. */
  private resetTurnGuards(): void {
    this.loopGuard.reset();
    this.turnCap.reset();
  }

  private async runCommandPlan(plan: AgentCommandPlan): Promise<void> {
    if (plan.type === "error") {
      this.setError(plan.message);
      return;
    }
    await this.runPrompt((agent) => agent.prompt(plan.prompt));
  }

  private setError(message: string): void {
    this.sessionState.setErrorMessage(message);
    this.notifyChange();
  }

  private notifyChange(): void {
    this.listeners.notifyChange();
  }

  /** Steered text pi never delivered; the composer takes it back. */
  private readonly undeliveredSteers: string[] = [];

  /**
   * Steered text that never reached the model because the run ended or was
   * stopped first. Each text is returned once; the UI puts it back in the composer.
   */
  takeUndeliveredSteers(): string[] {
    return this.undeliveredSteers.splice(0);
  }

  /**
   * pi polls its queues only between turns, so a run that ends early (turn cap,
   * loop guard) or a steer that lands after the last poll leaves messages
   * queued, and the next prompt would deliver them as new. Drain them on the
   * idle agent before and after every run, inside the prompt turn so the UI
   * sees them on the run's settle notification.
   */
  private settlingQueues(run: PromptTurnRun): PromptTurnRun {
    return async (agent) => {
      this.takeQueuedMessages(agent);
      try {
        await run(agent);
      } finally {
        if (!agent.state.isStreaming) this.takeQueuedMessages(agent);
      }
    };
  }

  /** Empty both queues and keep the user text they carried as undelivered. */
  private takeQueuedMessages(agent: Agent): void {
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
        if (text) this.undeliveredSteers.push(text);
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

function createUserMessage(text: string, images?: ImageContent[]): UserMessage {
  const content: UserMessage["content"] = [{ type: "text", text }];
  if (images) content.push(...images);
  return { role: "user", content, timestamp: Date.now() };
}
