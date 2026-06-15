import type { App } from "obsidian";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  generateSummary,
  type Skill,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { streamSimple, type Usage } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import { activeModelId, apiKeyForProvider, activeModelConfig } from "../settings";
import { buildModel, type ModelConfig } from "../llm/models";
import { createVaultTools, MUTATING_TOOLS } from "../tools/vault-tools";
import { createSubagentTool, SUBAGENT_TOOL_NAME, normalizeTasks } from "../tools/subagent-tool";
import { createIgnoreMatcher, parseIgnorePatterns, type IgnoreMatcher } from "../vault/ignore";
import { deriveAutoName, ObsidianSessionManager, type SessionDefaults, type SessionInfo } from "../session/session-manager";
import { buildSkillInvocation, loadVaultSkills } from "../skills/skills";
import { type AgentProfile, formatSubagentsForSystemPrompt, loadAgentProfiles } from "./subagents";
import { addUsage, emptyUsage, sumAssistantUsage } from "./usage";
import { type CompactionConfig, DEFAULT_COMPACTION_CONFIG, buildSummaryMessage, planCompaction } from "./compaction";
import { buildSystemPrompt } from "./system-prompt";
import { MODES, resolveModePolicy } from "./modes";
import { OUTPUT_STYLES } from "./output-styles";

const HTTP_REFERER = "https://github.com/tardigrde/obsidian-agentic-chat";
const X_TITLE = "Obsidian Agentic Chat";

/** Tokens reserved for the summarization prompt + its output during compaction. */
const COMPACTION_RESERVE_TOKENS = 16_384;

/** A pending tool call the user must approve. */
export interface ToolApprovalRequest {
  toolName: string;
  label: string;
  args: unknown;
}

/**
 * Summarize a slice of transcript into compaction summary text. Injected for
 * tests; production calls the model through pi's `generateSummary`. Returns "" to
 * signal "no summary" so the caller skips compaction rather than dropping history.
 */
export type SummarizeFn = (messages: AgentMessage[], signal?: AbortSignal) => Promise<string>;

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
}

type EventListener = (event: AgentEvent) => void;
type ChangeListener = () => void;

/**
 * Owns the pi Agent for the chat view: model/tool/skill wiring, approval gates,
 * JSONL session persistence, and event/state fan-out to the UI.
 */
export class AgentService {
  private readonly app: App;
  private readonly getSettings: () => AgenticChatSettings;
  private readonly sessionManager: ObsidianSessionManager;
  private readonly confirmToolCall: (request: ToolApprovalRequest) => Promise<boolean>;
  private readonly injectedStreamFn?: StreamFn;
  private readonly injectedSummarize?: SummarizeFn;

  private agent: Agent | null = null;
  private unsubscribeAgent: (() => void) | null = null;
  private initialization: Promise<void> | null = null;
  /** Serializes session swaps so a rapid double-trigger can't interleave detach/create/replace. */
  private sessionSwap: Promise<void> = Promise.resolve();
  private persisted = new WeakSet<object>();
  private disposed = false;

  private skills: Skill[] = [];
  private profiles: AgentProfile[] = [];
  private ignoreMatcher: IgnoreMatcher = () => false;
  private sessionInfo: SessionInfo | undefined;
  private errorMessage: string | undefined;
  /** Token usage from subagent children, which live outside the parent transcript. */
  private subagentUsage: Usage = emptyUsage();
  /** Usage of assistant turns dropped by compaction, so the session total never shrinks. */
  private compactedUsage: Usage = emptyUsage();
  /** Count of compactions this session, so the UI can toast each one once. */
  private compactions = 0;

  private readonly eventListeners = new Set<EventListener>();
  private readonly changeListeners = new Set<ChangeListener>();

  constructor(options: AgentServiceOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    this.sessionManager = options.sessionManager;
    this.confirmToolCall = options.confirmToolCall;
    this.injectedStreamFn = options.streamFn;
    this.injectedSummarize = options.summarize;
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onChange(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  getMessages(): AgentMessage[] {
    return this.agent?.state.messages ?? [];
  }

  isStreaming(): boolean {
    return this.agent?.state.isStreaming ?? false;
  }

  getError(): string | undefined {
    return this.errorMessage ?? this.agent?.state.errorMessage;
  }

  getSessionInfo(): SessionInfo | undefined {
    return this.sessionInfo;
  }

  getSkills(): Skill[] {
    return this.skills;
  }

  getProfiles(): AgentProfile[] {
    return this.profiles;
  }

  /**
   * Fraction (0–1) of the model's context window filled by the most recent turn.
   * Uses the last assistant turn's input tokens (the prompt pi sent that turn) as
   * a proxy for how full the next request will be. Undefined if unknown.
   */
  getContextFraction(): number | undefined {
    const contextWindow = this.agent?.state.model?.contextWindow ?? 0;
    if (contextWindow <= 0) return undefined;
    // Walk back from the latest message to the most recent assistant turn with usage.
    const messages = this.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      const input = message.role === "assistant" ? message.usage?.input ?? 0 : 0;
      if (input > 0) return Math.min(input / contextWindow, 1);
    }
    return undefined;
  }

  /** Sum token usage and cost across all assistant turns in the active session. */
  getSessionUsage(): Usage {
    const total = emptyUsage();
    for (const message of this.getMessages()) {
      if (message.role === "assistant" && message.usage) addUsage(total, message.usage);
    }
    // Children run outside the parent transcript, so fold their usage in here.
    addUsage(total, this.subagentUsage);
    // Turns dropped by compaction are no longer in the transcript; fold them in
    // too so the session total reflects everything spent, not just what's kept.
    addUsage(total, this.compactedUsage);
    return total;
  }

  /** Number of times this session has been auto-compacted (for one-shot UI notices). */
  getCompactionCount(): number {
    return this.compactions;
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

  async sendPrompt(prompt: string): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    await this.runPrompt(() => this.requireAgent().prompt(trimmed));
  }

  async invokeSkill(name: string, args?: string): Promise<void> {
    const skill = this.skills.find((item) => item.name === name);
    if (!skill) {
      this.setError(`No skill named "${name}".`);
      return;
    }
    const text = buildSkillInvocation(skill, args);
    await this.runPrompt(() => this.requireAgent().prompt(text));
  }

  /** User-driven dispatch: ask the model to delegate a task to a named subagent. */
  async invokeAgent(name: string, task: string): Promise<void> {
    const profile = this.profiles.find((item) => item.name === name);
    if (!profile) {
      this.setError(`No subagent named "${name}".`);
      return;
    }
    const trimmed = task.trim();
    if (!trimmed) {
      this.setError(`Give the "${name}" subagent a task, e.g. /agent ${name} <task>.`);
      return;
    }
    const directive = `Use the subagent tool to delegate this task to the "${name}" subagent: ${trimmed}`;
    await this.runPrompt(() => this.requireAgent().prompt(directive));
  }

  abort(): void {
    const agent = this.agent;
    if (!agent) return;
    agent.abort();
    void agent.waitForIdle().then(() => this.notifyChange());
  }

  async newSession(): Promise<void> {
    return this.enqueueSessionSwap(async () => {
      this.detachAgent();
      this.sessionInfo = await this.sessionManager.createSession(this.sessionDefaults());
      this.persisted = new WeakSet<object>();
      this.subagentUsage = emptyUsage();
    this.compactedUsage = emptyUsage();
    this.compactions = 0;
      await this.reloadResources();
      this.replaceAgent([]);
      this.errorMessage = undefined;
      this.notifyChange();
    });
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.sessionManager.listSessions();
  }

  async loadSession(path: string): Promise<void> {
    return this.enqueueSessionSwap(async () => {
      this.detachAgent();
      this.sessionInfo = await this.sessionManager.loadSession(path);
      this.persisted = new WeakSet<object>();
      this.subagentUsage = emptyUsage();
    this.compactedUsage = emptyUsage();
    this.compactions = 0;
      await this.reloadResources();
      this.replaceAgent(this.sessionManager.buildSessionContext().messages);
      this.errorMessage = undefined;
      this.notifyChange();
    });
  }

  /**
   * Run a session swap exclusively: chain it after any in-flight swap so two
   * rapid triggers (e.g. double-tapping "New conversation") can't interleave
   * detach/create/replace and corrupt the active session.
   */
  private enqueueSessionSwap(op: () => Promise<void>): Promise<void> {
    const next = this.sessionSwap.then(op, op);
    // Swallow rejections on the chain itself so one failure doesn't poison the
    // next swap; the awaited caller still sees the original rejection.
    this.sessionSwap = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async deleteSession(path: string): Promise<void> {
    const active = this.sessionManager.getActiveSessionPath();
    await this.sessionManager.deleteSession(path);
    if (active === path) await this.newSession();
    else this.notifyChange();
  }

  async renameSession(path: string, name: string): Promise<void> {
    await this.sessionManager.renameSession(path, name);
    // Refresh cached info so renaming the active session updates the chrome.
    if (this.sessionManager.hasActiveSession()) this.sessionInfo = this.sessionManager.getActiveSessionInfo();
    this.notifyChange();
  }

  /**
   * Rewind the conversation to just before message `index` (prompt editing): drop
   * that turn and everything after it, in memory and on disk, so the caller can
   * resend an edited prompt as a fresh branch.
   */
  async truncateMessages(index: number): Promise<void> {
    if (!this.agent || this.agent.state.isStreaming) return;
    const messages = this.getMessages().slice(0, Math.max(0, index));
    await this.sessionManager.rewriteMessages(messages);
    this.persisted = new WeakSet<object>();
    for (const message of messages) this.persisted.add(message as object);
    // Child usage isn't tracked per-message, so it can't be recomputed for the
    // surviving turns; zero it on rewind rather than let it over-count forever.
    this.subagentUsage = emptyUsage();
    this.compactedUsage = emptyUsage();
    this.compactions = 0;
    this.replaceAgent(messages);
    if (this.sessionManager.hasActiveSession()) this.sessionInfo = this.sessionManager.getActiveSessionInfo();
    this.errorMessage = undefined;
    this.notifyChange();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = null;
    this.agent?.abort();
    this.agent = null;
    this.eventListeners.clear();
    this.changeListeners.clear();
  }

  private async runPrompt(run: () => Promise<void>): Promise<void> {
    await this.initialize();
    const agent = this.requireAgent();
    if (agent.state.isStreaming) {
      this.setError("The agent is already responding.");
      return;
    }
    if (!this.hasApiKey()) {
      this.setError(`Add a ${this.getSettings().provider} API key in plugin settings before sending a prompt.`);
      return;
    }
    await this.refreshConfiguration();
    // Summarize old turns before the next request if the window is filling, so a
    // long session doesn't hit the model limit or spike cost. Never throws.
    await this.maybeCompact();
    try {
      this.errorMessage = undefined;
      this.notifyChange();
      await run();
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      this.notifyChange();
    }
  }

  private async initializeAgent(): Promise<void> {
    this.sessionInfo = await this.sessionManager.continueRecentSession(this.sessionDefaults());
    await this.reloadResources();
    this.replaceAgent(this.sessionManager.buildSessionContext().messages);
    this.notifyChange();
  }

  /**
   * Detach the current agent before an async session swap: unsubscribe first so
   * no late events from the outgoing (aborted) agent are handled against the new
   * session's `persisted` set, then abort it.
   */
  private detachAgent(): void {
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = null;
    this.agent?.abort();
    // Drop the reference so getMessages()/isStreaming() don't report stale
    // old-session state during the async gap before replaceAgent() runs.
    this.agent = null;
  }

  private replaceAgent(messages: AgentMessage[]): void {
    // A late initialize/load/new that resolves after dispose() must not resurrect
    // the agent or re-subscribe to events.
    if (this.disposed) return;
    this.unsubscribeAgent?.();
    const settings = this.getSettings();
    const agent = new Agent({
      streamFn: this.buildStreamFn(),
      initialState: {
        systemPrompt: this.composeSystemPrompt(settings),
        model: buildModel(activeModelConfig(settings)),
        thinkingLevel: settings.thinkingLevel,
        tools: this.buildParentTools(),
        messages,
      },
      getApiKey: (provider) => apiKeyForProvider(this.getSettings(), provider),
      beforeToolCall: async (context) => this.gateToolCall(context.toolCall.name, context.args),
      sessionId: this.sessionInfo?.id,
      toolExecution: "sequential",
    });
    this.agent = agent;
    this.unsubscribeAgent = agent.subscribe((event) => this.handleAgentEvent(event));
  }

  private async gateToolCall(
    toolName: string,
    args: unknown,
  ): Promise<{ block: true; reason: string } | undefined> {
    const settings = this.getSettings();
    if (toolName === SUBAGENT_TOOL_NAME) return this.gateSubagentDispatch(settings, args);
    const { policy, reason } = resolveModePolicy(settings.mode, settings.approval, toolName);
    if (policy === "allow") return undefined;
    if (policy === "deny") {
      return { block: true, reason: reason ?? `The "${toolName}" tool is disabled by your approval settings.` };
    }
    const tool = this.agent?.state.tools.find((candidate) => candidate.name === toolName);
    const approved = await this.confirmToolCall({ toolName, label: tool?.label ?? toolName, args });
    return approved ? undefined : { block: true, reason: "The user declined this action." };
  }

  /**
   * Gate a subagent dispatch. In a read-only mode (ask/plan) children are forced
   * read-only, so a dispatch is always safe. Otherwise it is gated like a mutating
   * action — but only when some dispatched profile can actually write, so a pure
   * research fan-out never prompts.
   */
  private async gateSubagentDispatch(
    settings: AgenticChatSettings,
    args: unknown,
  ): Promise<{ block: true; reason: string } | undefined> {
    if (settings.mode !== "agent") return undefined;
    if (!this.dispatchCanMutate(args)) return undefined;
    const policy = settings.approval.mutating;
    if (policy === "allow") return undefined;
    if (policy === "deny") {
      return { block: true, reason: "Subagent dispatch is blocked because mutating tools are denied." };
    }
    // This dispatch can mutate the vault and child writes then run unattended, so
    // make the one-time approval say so explicitly.
    const label = "Dispatch subagents (auto-approves their file changes)";
    const approved = await this.confirmToolCall({ toolName: SUBAGENT_TOOL_NAME, label, args });
    return approved ? undefined : { block: true, reason: "The user declined to dispatch subagents." };
  }

  /** True when any dispatched profile's allowlist includes a mutating tool. */
  private dispatchCanMutate(args: unknown): boolean {
    const tasks = normalizeTasks((args ?? {}) as Parameters<typeof normalizeTasks>[0]);
    return tasks.some((task) => {
      const profile = this.profiles.find((candidate) => candidate.name === task.agent);
      return !!profile && profile.toolAllowlist.some((name) => MUTATING_TOOLS.has(name));
    });
  }

  private composeSystemPrompt(settings: AgenticChatSettings): string {
    const overlays = [...promptOverlays(settings), formatSubagentsForSystemPrompt(this.profiles)];
    return buildSystemPrompt(settings.systemPrompt, this.skills, overlays);
  }

  /** Parent tool set: the vault tools, plus the subagent tool when profiles exist. */
  private buildParentTools(): AgentTool[] {
    const tools = createVaultTools(this.app, this.ignoreMatcher);
    if (this.profiles.length > 0) tools.push(this.createSubagentToolInstance());
    return tools;
  }

  private createSubagentToolInstance(): AgentTool {
    return createSubagentTool({
      getProfiles: () => this.profiles,
      createChildAgent: (profile) => this.createChildAgent(profile),
      recordUsage: (usage) => addUsage(this.subagentUsage, usage),
      defaultConcurrency: 3,
    });
  }

  /**
   * Build an isolated child agent for a profile: a filtered tool set (allowlist,
   * read-only when the parent mode forbids writes), the profile's prompt, and an
   * optional model override. Children never receive the subagent tool, so the
   * delegation depth is capped at one by construction.
   */
  private createChildAgent(profile: AgentProfile): Agent {
    const settings = this.getSettings();
    const readOnly = settings.mode !== "agent";
    const tools = filterChildTools(createVaultTools(this.app, this.ignoreMatcher), profile.toolAllowlist, readOnly);
    return new Agent({
      streamFn: this.buildStreamFn(),
      initialState: {
        systemPrompt: profile.systemPrompt,
        model: buildModel(childModelConfig(settings, profile.model)),
        thinkingLevel: settings.thinkingLevel,
        tools,
        messages: [],
      },
      getApiKey: (provider) => apiKeyForProvider(this.getSettings(), provider),
      // Tools are pre-filtered to the allowlist, so the child needs no per-call
      // gate: the user already approved the dispatch (see gateSubagentDispatch).
      toolExecution: "sequential",
    });
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    try {
      if (event.type === "message_end") {
        await this.persistMessage(event.message);
      }
      if (event.type === "agent_end") {
        for (const message of event.messages) await this.persistMessage(message);
        await this.autoNameSession();
      }
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
    }
    for (const listener of this.eventListeners) listener(event);
    if (event.type === "agent_end" || event.type === "agent_start") {
      if (this.sessionManager.getActiveSessionPath()) {
        this.sessionInfo = this.sessionManager.getActiveSessionInfo();
      }
      this.notifyChange();
    }
  }

  /** Name an as-yet-unnamed session after its first user prompt, once. */
  private async autoNameSession(): Promise<void> {
    if (!this.sessionManager.hasActiveSession()) return;
    const info = this.sessionManager.getActiveSessionInfo();
    if (info.name || info.messageCount === 0) return;
    const name = deriveAutoName(info.firstMessage);
    if (!name) return;
    await this.sessionManager.appendSessionName(name);
    this.sessionInfo = this.sessionManager.getActiveSessionInfo();
  }

  private async persistMessage(message: AgentMessage): Promise<void> {
    const key = message as object;
    if (this.persisted.has(key)) return;
    await this.sessionManager.appendMessage(message);
    this.persisted.add(key);
  }

  private async refreshConfiguration(): Promise<void> {
    const agent = this.requireAgent();
    const settings = this.getSettings();
    await this.reloadResources();
    agent.state.model = buildModel(activeModelConfig(settings));
    agent.state.thinkingLevel = settings.thinkingLevel;
    agent.state.tools = this.buildParentTools();
    agent.state.systemPrompt = this.composeSystemPrompt(settings);
    await this.sessionManager.ensureConfiguration(this.sessionDefaults());
    this.sessionInfo = this.sessionManager.getActiveSessionInfo();
  }

  /**
   * Auto-compaction: when the transcript fills past the configured threshold,
   * summarize the older turns into a single message and keep the recent ones, in
   * memory and on disk. Best-effort — any failure (no key, summary error, write
   * error) leaves the transcript untouched so a prompt is never lost.
   */
  private async maybeCompact(): Promise<void> {
    try {
      const agent = this.agent;
      if (!agent) return;
      const config = compactionConfig(this.getSettings());
      const contextWindow = agent.state.model?.contextWindow ?? 0;
      const plan = planCompaction(agent.state.messages, contextWindow, config);
      if (!plan) return;
      const summary = await this.summarizeForCompaction(plan.summarize);
      if (!summary.trim()) return;
      const newMessages = [buildSummaryMessage(summary, Date.now()), ...plan.keep];
      // Persist the rewrite first; only mutate in-memory state once disk succeeds.
      await this.sessionManager.rewriteMessages(newMessages);
      const dropped = sumAssistantUsage(plan.summarize);
      if (dropped) addUsage(this.compactedUsage, dropped);
      this.persisted = new WeakSet<object>();
      for (const message of newMessages) this.persisted.add(message as object);
      this.replaceAgent(newMessages);
      this.compactions += 1;
      if (this.sessionManager.hasActiveSession()) this.sessionInfo = this.sessionManager.getActiveSessionInfo();
      this.notifyChange();
    } catch {
      // Compaction is an optimization; never let it break the pending prompt.
    }
  }

  /**
   * Produce summary text for compaction. Tests inject a summarizer; production
   * summarizes through pi's `generateSummary` with the active model. The summary
   * call's own (small) token cost is not captured by `generateSummary`, so it is
   * left out of the session total.
   */
  private async summarizeForCompaction(messages: AgentMessage[]): Promise<string> {
    if (this.injectedSummarize) return this.injectedSummarize(messages);
    const settings = this.getSettings();
    const apiKey = apiKeyForProvider(settings, settings.provider);
    if (!apiKey) return "";
    const model = buildModel(activeModelConfig(settings));
    const result = await generateSummary(
      messages,
      model,
      COMPACTION_RESERVE_TOKENS,
      apiKey,
      { "HTTP-Referer": HTTP_REFERER, "X-Title": X_TITLE },
      undefined,
      undefined,
      undefined,
      settings.thinkingLevel,
    );
    return result.ok ? result.value : "";
  }

  private async reloadResources(): Promise<void> {
    const settings = this.getSettings();
    this.ignoreMatcher = createIgnoreMatcher(parseIgnorePatterns(settings.ignoredGlobs));
    // One skill concept: load the skills folder plus the deprecated templates
    // folder (folded in as skills, by name, skills folder winning on conflict).
    const skills = await loadVaultSkills(this.app, settings.skillsFolder);
    const legacyTemplates = settings.templatesFolder
      ? await loadVaultSkills(this.app, settings.templatesFolder)
      : [];
    const byName = new Map<string, Skill>();
    for (const skill of [...skills, ...legacyTemplates]) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
    this.skills = [...byName.values()];
    this.profiles = await loadAgentProfiles(this.app, settings.agentsFolder, settings.enableBuiltinAgents);
  }

  private buildStreamFn(): StreamFn {
    if (this.injectedStreamFn) return this.injectedStreamFn;
    return (model, context, options) => {
      const settings = this.getSettings();
      return streamSimple(model, context, {
        ...options,
        temperature: settings.temperature,
        ...(settings.maxTokens > 0 ? { maxTokens: settings.maxTokens } : {}),
        timeoutMs: settings.requestTimeoutMs,
        maxRetries: settings.maxNetworkRetries,
        headers: { "HTTP-Referer": HTTP_REFERER, "X-Title": X_TITLE, ...(options?.headers ?? {}) },
      });
    };
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
    if (!this.agent) throw new Error("Agent is not initialized.");
    return this.agent;
  }

  private setError(message: string): void {
    this.errorMessage = message;
    this.notifyChange();
  }

  private notifyChange(): void {
    for (const listener of this.changeListeners) listener();
  }
}

/** Map the persisted (percent-based) compaction settings to a {@link CompactionConfig}. */
function compactionConfig(settings: AgenticChatSettings): CompactionConfig {
  const percent = settings.compaction?.thresholdPercent ?? DEFAULT_COMPACTION_CONFIG.thresholdFraction * 100;
  const thresholdFraction = Math.min(0.95, Math.max(0.5, percent / 100));
  return {
    enabled: settings.compaction?.enabled ?? DEFAULT_COMPACTION_CONFIG.enabled,
    thresholdFraction,
    keepFraction: DEFAULT_COMPACTION_CONFIG.keepFraction,
  };
}

/** System-prompt overlays contributed by the active mode and output style. */
function promptOverlays(settings: AgenticChatSettings): string[] {
  return [MODES[settings.mode].promptOverlay, OUTPUT_STYLES[settings.outputStyle].promptOverlay];
}

/** Resolve the model config for a child, overriding only the model id when given. */
function childModelConfig(settings: AgenticChatSettings, modelOverride?: string): ModelConfig {
  const base = activeModelConfig(settings);
  return modelOverride ? { ...base, modelId: modelOverride } : base;
}

/**
 * Restrict a child's tools to its profile allowlist. An empty allowlist defaults
 * to the read-only vault tools; when the parent mode forbids writes, mutating
 * tools are stripped regardless of the allowlist.
 */
export function filterChildTools(tools: AgentTool[], allowlist: string[], readOnly: boolean): AgentTool[] {
  let allowed =
    allowlist.length > 0
      ? tools.filter((tool) => allowlist.includes(tool.name))
      : tools.filter((tool) => !MUTATING_TOOLS.has(tool.name));
  if (readOnly) allowed = allowed.filter((tool) => !MUTATING_TOOLS.has(tool.name));
  return allowed;
}

