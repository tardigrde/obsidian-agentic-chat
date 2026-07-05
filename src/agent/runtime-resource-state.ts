import type { App } from "obsidian";
import type { AgentTool, Skill } from "@earendil-works/pi-agent-core";
import type { AgenticChatSettings } from "../settings";
import type { WebFetcher } from "../tools/web-fetch";
import type { AskUserHandler } from "../tools/ask-user-tool";
import type { ReadMemo } from "../vault/read-memo";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import type { ExternalInspectCache } from "../tools/external-workspace";
import type { AgentProfile } from "./subagents";
import {
  EMPTY_AGENT_RUNTIME_RESOURCES,
  buildAgentParentTools,
  composeAgentSystemPrompt,
  loadAgentRuntimeResources,
  type AgentRuntimeResources,
} from "./runtime-resources";
import {
  createToolBudgetState,
  DEFAULT_TOOL_BUDGET_SETTINGS,
  resetToolBudgetState,
  type ToolBudgetSnapshot,
} from "./tool-budget";

export interface BuildParentToolsOptions {
  contextWindow?: number;
}

export interface AgentRuntimeResourceStateOptions {
  app: App;
  getSettings: () => AgenticChatSettings;
  readMemo: ReadMemo;
  webFetch: WebFetcher;
  askUser?: AskUserHandler;
  saveSettings?: () => void | Promise<void>;
  artifactStore?: ToolArtifactStoreLike;
}

export class AgentRuntimeResourceState {
  private resources: AgentRuntimeResources = EMPTY_AGENT_RUNTIME_RESOURCES;
  private reloadedAt: string | null = null;
  private readonly toolBudgetState = createToolBudgetState();
  private readonly externalInspectCache: ExternalInspectCache = new Map();
  private toolBudgetSnapshot: ToolBudgetSnapshot = {
    enabled: DEFAULT_TOOL_BUDGET_SETTINGS.enabled,
    active: false,
    thresholdPercent: DEFAULT_TOOL_BUDGET_SETTINGS.thresholdPercent,
    triggeredAtToolSchemaPercent: null,
    toolSchemaTokens: null,
    contextWindow: null,
    droppedTools: [],
  };

  constructor(private readonly options: AgentRuntimeResourceStateOptions) {}

  get current(): AgentRuntimeResources {
    return this.resources;
  }

  get lastReloadAt(): string | null {
    return this.reloadedAt;
  }

  getSkills(): Skill[] {
    return this.resources.skills;
  }

  getProfiles(): AgentProfile[] {
    return this.resources.profiles;
  }

  getToolBudgetSnapshot(): ToolBudgetSnapshot {
    return this.toolBudgetSnapshot;
  }

  isPathIgnored(path: string): boolean {
    return this.resources.ignoreMatcher(path);
  }

  clearSessionState(): void {
    resetToolBudgetState(this.toolBudgetState);
    this.externalInspectCache.clear();
    const settings = this.options.getSettings();
    this.toolBudgetSnapshot = {
      enabled: settings.toolBudget.enabled,
      active: false,
      thresholdPercent: settings.toolBudget.thresholdPercent,
      triggeredAtToolSchemaPercent: null,
      toolSchemaTokens: null,
      contextWindow: null,
      droppedTools: [],
    };
  }

  async reload(): Promise<AgentRuntimeResources> {
    this.resources = await loadAgentRuntimeResources(
      this.options.app,
      this.options.getSettings(),
      this.options.webFetch,
      this.options.saveSettings,
      this.options.artifactStore,
    );
    this.reloadedAt = new Date().toISOString();
    return this.resources;
  }

  composeSystemPrompt(settings: AgenticChatSettings, activeModelId: string): string {
    return composeAgentSystemPrompt(settings, this.resources, this.selfAwarenessOverlay(activeModelId));
  }

  buildParentTools(
    settings: AgenticChatSettings,
    subagentTool?: AgentTool,
    buildOptions: BuildParentToolsOptions = {},
  ): AgentTool[] {
    const result = buildAgentParentTools({
      app: this.options.app,
      settings,
      resources: this.resources,
      readMemo: this.options.readMemo,
      webFetch: this.options.webFetch,
      artifactStore: this.options.artifactStore,
      askUser: this.options.askUser,
      subagentTool,
      contextWindow: buildOptions.contextWindow,
      toolBudgetState: this.toolBudgetState,
      externalInspectCache: this.externalInspectCache,
    });
    this.toolBudgetSnapshot = result.toolBudget;
    return result.tools;
  }

  private selfAwarenessOverlay(activeModelId: string): string {
    return `Identity: you are the "agentic-chat" Obsidian plugin. You are currently using the model "${activeModelId}".`;
  }
}
