import type { App } from "obsidian";
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type PromptTemplate,
  type Skill,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { streamSimple, type Usage } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings";
import { activeModelId, apiKeyForProvider, activeModelConfig } from "../settings";
import { buildModel } from "../llm/models";
import { createVaultTools } from "../tools/vault-tools";
import { createIgnoreMatcher, parseIgnorePatterns, type IgnoreMatcher } from "../vault/ignore";
import { ObsidianSessionManager, type SessionDefaults, type SessionInfo } from "../session/session-manager";
import {
  formatPromptTemplateInvocation,
  formatSkillInvocation,
  loadVaultPromptTemplates,
  loadVaultSkills,
} from "../skills/skills";
import { buildSystemPrompt } from "./system-prompt";
import { type ApprovalPolicy, resolvePolicy } from "./approval";

const HTTP_REFERER = "https://github.com/tardigrde/obsidian-agentic-chat";
const X_TITLE = "Obsidian Agentic Chat";

/** A pending tool call the user must approve. */
export interface ToolApprovalRequest {
  toolName: string;
  label: string;
  args: unknown;
}

export interface AgentServiceOptions {
  app: App;
  getSettings: () => AgenticChatSettings;
  sessionManager: ObsidianSessionManager;
  /** Resolve an "ask" approval gate; returns true to allow the tool call. */
  confirmToolCall: (request: ToolApprovalRequest) => Promise<boolean>;
  /** Injected for tests; production wraps pi-ai streamSimple. */
  streamFn?: StreamFn;
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

  private agent: Agent | null = null;
  private unsubscribeAgent: (() => void) | null = null;
  private initialization: Promise<void> | null = null;
  private persisted = new WeakSet<object>();

  private skills: Skill[] = [];
  private templates: PromptTemplate[] = [];
  private ignoreMatcher: IgnoreMatcher = () => false;
  private sessionInfo: SessionInfo | undefined;
  private errorMessage: string | undefined;

  private readonly eventListeners = new Set<EventListener>();
  private readonly changeListeners = new Set<ChangeListener>();

  constructor(options: AgentServiceOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    this.sessionManager = options.sessionManager;
    this.confirmToolCall = options.confirmToolCall;
    this.injectedStreamFn = options.streamFn;
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

  getTemplates(): PromptTemplate[] {
    return this.templates;
  }

  /** Sum token usage and cost across all assistant turns in the active session. */
  getSessionUsage(): Usage {
    const total = emptyUsage();
    for (const message of this.getMessages()) {
      if (message.role === "assistant" && message.usage) addUsage(total, message.usage);
    }
    return total;
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

  async invokeSkill(name: string, additionalInstructions?: string): Promise<void> {
    const skill = this.skills.find((item) => item.name === name);
    if (!skill) {
      this.setError(`No skill named "${name}".`);
      return;
    }
    const text = formatSkillInvocation(skill, additionalInstructions);
    await this.runPrompt(() => this.requireAgent().prompt(text));
  }

  async invokeTemplate(name: string, args: string[]): Promise<void> {
    const template = this.templates.find((item) => item.name === name);
    if (!template) {
      this.setError(`No prompt template named "${name}".`);
      return;
    }
    const text = formatPromptTemplateInvocation(template, args);
    await this.runPrompt(() => this.requireAgent().prompt(text));
  }

  abort(): void {
    const agent = this.agent;
    if (!agent) return;
    agent.abort();
    void agent.waitForIdle().then(() => this.notifyChange());
  }

  async newSession(): Promise<void> {
    this.agent?.abort();
    this.sessionInfo = await this.sessionManager.createSession(this.sessionDefaults());
    this.persisted = new WeakSet<object>();
    await this.reloadResources();
    this.replaceAgent([]);
    this.errorMessage = undefined;
    this.notifyChange();
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.sessionManager.listSessions();
  }

  async loadSession(path: string): Promise<void> {
    this.agent?.abort();
    this.sessionInfo = await this.sessionManager.loadSession(path);
    this.persisted = new WeakSet<object>();
    await this.reloadResources();
    this.replaceAgent(this.sessionManager.buildSessionContext().messages);
    this.errorMessage = undefined;
    this.notifyChange();
  }

  async deleteSession(path: string): Promise<void> {
    const active = this.sessionManager.getActiveSessionPath();
    await this.sessionManager.deleteSession(path);
    if (active === path) await this.newSession();
    else this.notifyChange();
  }

  dispose(): void {
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = null;
    this.agent?.abort();
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

  private replaceAgent(messages: AgentMessage[]): void {
    this.unsubscribeAgent?.();
    const settings = this.getSettings();
    const agent = new Agent({
      streamFn: this.buildStreamFn(),
      initialState: {
        systemPrompt: buildSystemPrompt(settings.systemPrompt, this.skills),
        model: buildModel(activeModelConfig(settings)),
        thinkingLevel: settings.thinkingLevel,
        tools: createVaultTools(this.app, this.ignoreMatcher),
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
    const policy: ApprovalPolicy = resolvePolicy(this.getSettings().approval, toolName);
    if (policy === "allow") return undefined;
    if (policy === "deny") {
      return { block: true, reason: `The "${toolName}" tool is disabled by your approval settings.` };
    }
    const tool = this.agent?.state.tools.find((candidate) => candidate.name === toolName);
    const approved = await this.confirmToolCall({ toolName, label: tool?.label ?? toolName, args });
    return approved ? undefined : { block: true, reason: "The user declined this action." };
  }

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    try {
      if (event.type === "message_end") {
        await this.persistMessage(event.message);
      }
      if (event.type === "agent_end") {
        for (const message of event.messages) await this.persistMessage(message);
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
    agent.state.tools = createVaultTools(this.app, this.ignoreMatcher);
    agent.state.systemPrompt = buildSystemPrompt(settings.systemPrompt, this.skills);
    await this.sessionManager.ensureConfiguration(this.sessionDefaults());
    this.sessionInfo = this.sessionManager.getActiveSessionInfo();
  }

  private async reloadResources(): Promise<void> {
    const settings = this.getSettings();
    this.ignoreMatcher = createIgnoreMatcher(parseIgnorePatterns(settings.ignoredGlobs));
    this.skills = await loadVaultSkills(this.app, settings.skillsFolder);
    this.templates = await loadVaultPromptTemplates(this.app, settings.templatesFolder);
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

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(into: Usage, from: Usage): void {
  into.input += from.input ?? 0;
  into.output += from.output ?? 0;
  into.cacheRead += from.cacheRead ?? 0;
  into.cacheWrite += from.cacheWrite ?? 0;
  into.totalTokens += from.totalTokens ?? 0;
  // Local providers (and malformed records) may omit cost entirely.
  if (from.cost) {
    into.cost.input += from.cost.input ?? 0;
    into.cost.output += from.cost.output ?? 0;
    into.cost.cacheRead += from.cost.cacheRead ?? 0;
    into.cost.cacheWrite += from.cost.cacheWrite ?? 0;
    into.cost.total += from.cost.total ?? 0;
  }
}
