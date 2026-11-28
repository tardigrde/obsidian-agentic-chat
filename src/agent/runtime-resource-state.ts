import type { App } from "obsidian";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { formatSkillsForSystemPrompt, type Skill } from "../skills/skill-prompt";
import type { ContextLoadParts } from "./readouts";
import type { AgenticChatSettings } from "../settings-schema";
import type { WebFetcher } from "../tools/web-fetch";
import type { AskUserHandler } from "../tools/ask-user-tool";
import type { ReadMemo } from "../vault/read-memo";
import type { PrivateMatcher } from "../vault/private-rules";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import type { AgentRole } from "./subagents";
import type { PluginCatalog } from "../plugins/service";
import {
  EMPTY_AGENT_RUNTIME_RESOURCES,
  buildAgentParentTools,
  composeAgentSystemPrompt,
  loadAgentRuntimeResources,
  type AgentParentTools,
  type AgentRuntimeResources,
} from "./runtime-resources";
import { LoadedToolSet, isDeferredToolName, partitionTools } from "./tool-loading";

export interface AgentRuntimeResourceStateOptions {
  app: App;
  getSettings: () => AgenticChatSettings;
  readMemo: ReadMemo;
  webFetch: WebFetcher;
  askUser?: AskUserHandler;
  saveSettings?: () => void | Promise<void>;
  artifactStore?: ToolArtifactStoreLike;
  /** Shared plugin catalog; without it the runtime scans the plugins folder itself. */
  plugins?: PluginCatalog;
  /** Clock for `current_time`; tests inject a fixed one. */
  now?: () => Date;
}

export class AgentRuntimeResourceState {
  private resources: AgentRuntimeResources = EMPTY_AGENT_RUNTIME_RESOURCES;
  private reloadedAt: string | null = null;
  private readonly loadedTools = new LoadedToolSet();
  private lastBuild: AgentParentTools | null = null;

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

  getProfiles(): AgentRole[] {
    return this.resources.profiles;
  }

  /** Names of the deferred tools loaded in this session. */
  getLoadedToolNames(): string[] {
    return this.loadedTools.list();
  }

  isPathIgnored(path: string): boolean {
    return this.resources.ignoreMatcher(path);
  }

  /** True when a built-in protected folder (not a user rule) blocks `path`. */
  isPathProtected(path: string): boolean {
    return (this.resources.ignoreMatcher as PrivateMatcher).isProtected?.(path) ?? false;
  }

  /**
   * Reset session-local state for a newly active transcript. The loaded
   * deferred tools are rebuilt from that transcript, so a reopened session can
   * still call the tools it loaded before.
   */
  clearSessionState(messages: readonly AgentMessage[] = []): void {
    this.loadedTools.restoreFromMessages(messages);
  }

  async reload(): Promise<AgentRuntimeResources> {
    // One catalog: take the PluginService cache when it holds a scan. Never call
    // its load(): that reload prunes plugin settings and saves, and the runtime
    // reloads at startup and after every invalidation.
    const plugins = this.options.plugins?.peekLoaded() ?? undefined;
    this.resources = await loadAgentRuntimeResources(
      this.options.app,
      this.options.getSettings(),
      this.options.webFetch,
      this.options.saveSettings,
      this.options.artifactStore,
      plugins,
    );
    this.reloadedAt = new Date().toISOString();
    return this.resources;
  }

  composeSystemPrompt(settings: AgenticChatSettings, activeModelId: string): string {
    return composeAgentSystemPrompt(
      settings,
      this.resources,
      this.selfAwarenessOverlay(activeModelId),
      // The whole deferred catalog, loaded or not: the prompt must not change
      // when search_tools loads a tool, or every load would break the prompt cache.
      this.build(settings).all.filter((tool) => isDeferredToolName(tool.name)),
    );
  }

  /** What the system prompt and tool catalog hold, for the context breakdown. */
  contextParts(settings: AgenticChatSettings, activeTools: readonly AgentTool[]): ContextLoadParts {
    const active = new Set(activeTools.map((tool) => tool.name));
    // Only MCP tools count here; the tooltip labels them "MCP deferred".
    const deferred = (this.lastBuild ?? this.build(settings)).all.filter((tool) => isDeferredToolName(tool.name) && tool.name.startsWith("mcp__"));
    return {
      instructions: this.resources.instructionsOverlay,
      skills: this.resources.skills.length > 0 ? formatSkillsForSystemPrompt(this.resources.skills) : "",
      deferredNotLoaded: deferred.filter((tool) => !active.has(tool.name)).length,
    };
  }

  buildParentTools(settings: AgenticChatSettings, subagentTool?: AgentTool): AgentTool[] {
    this.lastBuild = this.build(settings, subagentTool);
    return this.lastBuild.active;
  }

  /**
   * Tool changes for the next step of a running turn. `search_tools` adds to
   * the loaded set while it runs; a direct call to a deferred tool that was not
   * loaded fails once ("not found") and loads the tool. Returns the new active
   * tool list when it changed, else undefined.
   */
  toolsForNextStep(currentTools: readonly AgentTool[], toolResults: readonly ToolResultMessage[]): AgentTool[] | undefined {
    const build = this.lastBuild;
    if (!build) return undefined;
    const known = new Set(build.all.map((tool) => tool.name));
    const missed = toolResults
      .filter((result) => result.isError && isDeferredToolName(result.toolName) && known.has(result.toolName))
      .map((result) => result.toolName);
    this.loadedTools.add(missed);
    const { active } = partitionTools(build.all, this.loadedTools);
    const current = new Set(currentTools.map((tool) => tool.name));
    if (active.length === current.size && active.every((tool) => current.has(tool.name))) return undefined;
    return active;
  }

  private build(settings: AgenticChatSettings, subagentTool?: AgentTool): AgentParentTools {
    return buildAgentParentTools({
      app: this.options.app,
      settings,
      resources: this.resources,
      readMemo: this.options.readMemo,
      webFetch: this.options.webFetch,
      artifactStore: this.options.artifactStore,
      askUser: this.options.askUser,
      subagentTool,
      loadedTools: this.loadedTools,
      now: this.options.now,
    });
  }

  private selfAwarenessOverlay(activeModelId: string): string {
    return `Identity: you are the "agentic-chat" Obsidian plugin. You are currently using the model "${activeModelId}".`;
  }
}
