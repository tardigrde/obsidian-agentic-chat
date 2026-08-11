import { type App } from "obsidian";
import type { AgentTool, Skill } from "@earendil-works/pi-agent-core";
import type { AgenticChatSettings } from "../settings";
import { builtinSkills } from "../skills/builtin-skills";
import {
  loadPlugins,
  mergePluginMcpServers,
  type LoadedPlugin,
} from "../plugins/loader";
import { createVaultTools } from "../tools/vault-tools";
import { createWebTools } from "../tools/web-tools";
import { createMemoryTools } from "../tools/memory-tools";
import { createDocumentTools } from "../tools/document-tools";
import type { WebFetcher } from "../tools/web-fetch";
import { createAskUserTool, type AskUserHandler } from "../tools/ask-user-tool";
import { createReadSkillTool } from "../tools/read-skill-tool";
import { createMcpFetcher } from "../mcp/fetcher";
import { createMcpToolsWithDiagnostics, type McpServerDiagnostic } from "../mcp/tools";
import { createToolArtifactTools } from "../artifacts/tool-artifact-tools";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import { createIgnoreMatcher, parseIgnorePatterns, type IgnoreMatcher } from "../vault/ignore";
import type { ReadMemo } from "../vault/read-memo";
import { formatInstructionsOverlay, loadVaultInstructions } from "./instructions";
import { type AgentProfile, formatSubagentsForSystemPrompt, loadAgentProfiles } from "./subagents";
import { buildSystemPrompt } from "./system-prompt";
import { MODES } from "./modes";
import { OUTPUT_STYLES } from "./output-styles";
import {
  applyToolBudget,
  type ToolBudgetSnapshot,
  type ToolBudgetState,
} from "./tool-budget";

export interface AgentRuntimeResources {
  skills: Skill[];
  plugins: LoadedPlugin[];
  profiles: AgentProfile[];
  instructionsOverlay: string;
  ignoreMatcher: IgnoreMatcher;
  mcpTools: AgentTool[];
  mcpDiagnostics: McpServerDiagnostic[];
}

export const EMPTY_AGENT_RUNTIME_RESOURCES: AgentRuntimeResources = {
  skills: [],
  plugins: [],
  profiles: [],
  instructionsOverlay: "",
  ignoreMatcher: () => false,
  mcpTools: [],
  mcpDiagnostics: [],
};

export async function loadAgentRuntimeResources(
  app: App,
  settings: AgenticChatSettings,
  webFetch?: WebFetcher,
  onSettingsChanged?: () => void | Promise<void>,
  artifactStore?: ToolArtifactStoreLike,
): Promise<AgentRuntimeResources> {
  const ignoreMatcher = createIgnoreMatcher(parseIgnorePatterns(settings.ignoredGlobs));
  const plugins = await loadPlugins(app, {
    folder: settings.plugins.folder,
    enabledPlugins: settings.plugins.enabled,
  });
  const skills = await loadRuntimeSkills(app, settings, plugins);
  const profiles = await loadAgentProfiles(app, settings.agentsFolder, settings.enableBuiltinAgents);
  // Standing instructions (AGENTS.md -> CLAUDE.md -> GEMINI.md at the vault root):
  // re-read every turn so agent/user edits land in the next system prompt. The
  // adapter guard keeps minimal test harnesses working.
  const adapter = app.vault.adapter;
  const instructionsOverlay = adapter ? formatInstructionsOverlay(await loadVaultInstructions(adapter)) : "";
  const mcpProxySettings = settings.mcp.proxyUrl
    ? settings.mcp
    : { proxyUrl: settings.network.proxyUrl, noProxy: settings.network.noProxy };
  // Plugin mcp.json is the source of truth for server shape; persisted
  // client-owned state (enable, approval, auth) is merged by id.
  const pluginServers = plugins.flatMap((plugin) => plugin.mcpServers);
  const mcpServers = mergePluginMcpServers(settings.mcp.servers, pluginServers);
  const mcp = webFetch
    ? await createMcpToolsWithDiagnostics(
        { ...settings.mcp, servers: mcpServers },
        createMcpFetcher(mcpProxySettings, webFetch),
        {
          onServerChanged: onSettingsChanged,
          artifactStore,
        },
      )
    : { tools: [], diagnostics: [] };
  return {
    skills,
    plugins,
    profiles,
    instructionsOverlay,
    ignoreMatcher,
    mcpTools: mcp.tools,
    mcpDiagnostics: mcp.diagnostics,
  };
}

export function composeAgentSystemPrompt(
  settings: AgenticChatSettings,
  resources: AgentRuntimeResources,
  selfAwarenessOverlay: string,
): string {
  const overlays = [
    selfAwarenessOverlay,
    resources.instructionsOverlay,
    MODES[settings.mode].promptOverlay,
    OUTPUT_STYLES[settings.outputStyle].promptOverlay,
    formatSubagentsForSystemPrompt(resources.profiles),
  ];
  return buildSystemPrompt(settings.systemPrompt, resources.skills, overlays);
}

export function buildAgentParentTools(options: {
  app: App;
  settings: AgenticChatSettings;
  resources: AgentRuntimeResources;
  readMemo: ReadMemo;
  webFetch: WebFetcher;
  artifactStore?: ToolArtifactStoreLike;
  askUser?: AskUserHandler;
  subagentTool?: AgentTool;
  contextWindow?: number;
  toolBudgetState?: ToolBudgetState;
}): { tools: AgentTool[]; toolBudget: ToolBudgetSnapshot } {
  const tools = [
    ...createVaultTools(options.app, options.resources.ignoreMatcher, options.readMemo),
    ...(options.askUser ? [createAskUserTool(options.askUser)] : []),
    ...createMemoryTools(options.app),
    ...createDocumentTools(options.app, options.artifactStore),
    ...createWebTools(options.settings.web, options.webFetch, options.artifactStore),
    ...createToolArtifactTools(options.artifactStore),
    ...options.resources.mcpTools,
    createReadSkillTool(options.resources.skills),
    ...(options.subagentTool ? [options.subagentTool] : []),
  ];
  const budgeted = applyToolBudget({
    tools,
    settings: options.settings.toolBudget,
    state:
      options.toolBudgetState ?? {
        droppedToolNames: new Set<string>(),
        triggeredAtToolSchemaFraction: null,
        toolSchemaTokens: null,
      },
    contextWindow: options.contextWindow,
  });
  return { tools: budgeted.tools, toolBudget: budgeted.snapshot };
}

async function loadRuntimeSkills(
  app: App,
  settings: AgenticChatSettings,
  plugins: LoadedPlugin[],
): Promise<Skill[]> {
  // One skill concept, one parser: plugin skills plus built-ins, merged by
  // name with vault-loaded plugin skills first (kept-first map), so plugins
  // can shadow built-ins of the same name.
  const pluginSkills = plugins.filter((plugin) => plugin.enabled).flatMap((plugin) => plugin.skills);
  const byName = new Map<string, Skill>();
  for (const skill of [...pluginSkills, ...builtinSkills(settings.web.enabled)]) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()];
}
