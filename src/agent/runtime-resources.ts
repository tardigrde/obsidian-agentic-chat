import { Platform, type App } from "obsidian";
import type { AgentTool, Skill } from "@earendil-works/pi-agent-core";
import type { AgenticChatSettings } from "../settings";
import { loadVaultSkills } from "../skills/skills";
import { builtinSkills } from "../skills/builtin-skills";
import { createVaultTools } from "../tools/vault-tools";
import { createWebTools } from "../tools/web-tools";
import { createMemoryTools } from "../tools/memory-tools";
import { createDocumentTools } from "../tools/document-tools";
import { createExternalWorkspaceTools, type ExternalInspectCache } from "../tools/external-workspace";
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
import { formatExternalWorkspaceForSystemPrompt } from "./external-workspace-prompt";
import { MODES } from "./modes";
import { OUTPUT_STYLES } from "./output-styles";
import {
  applyToolBudget,
  type ToolBudgetSnapshot,
  type ToolBudgetState,
} from "./tool-budget";

export interface AgentRuntimeResources {
  skills: Skill[];
  profiles: AgentProfile[];
  instructionsOverlay: string;
  ignoreMatcher: IgnoreMatcher;
  mcpTools: AgentTool[];
  mcpDiagnostics: McpServerDiagnostic[];
}

export const EMPTY_AGENT_RUNTIME_RESOURCES: AgentRuntimeResources = {
  skills: [],
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
  const skills = await loadRuntimeSkills(app, settings);
  const profiles = await loadAgentProfiles(app, settings.agentsFolder, settings.enableBuiltinAgents);
  // Standing instructions (AGENTS.md -> CLAUDE.md -> GEMINI.md at the vault root):
  // re-read every turn so agent/user edits land in the next system prompt. The
  // adapter guard keeps minimal test harnesses working.
  const adapter = app.vault.adapter;
  const instructionsOverlay = adapter ? formatInstructionsOverlay(await loadVaultInstructions(adapter)) : "";
  const mcpProxySettings = settings.mcp.proxyUrl
    ? settings.mcp
    : { proxyUrl: settings.network.proxyUrl, noProxy: settings.network.noProxy };
  const mcp = webFetch
    ? await createMcpToolsWithDiagnostics(settings.mcp, createMcpFetcher(mcpProxySettings, webFetch), {
        onServerChanged: onSettingsChanged,
        artifactStore,
      })
    : { tools: [], diagnostics: [] };
  return { skills, profiles, instructionsOverlay, ignoreMatcher, mcpTools: mcp.tools, mcpDiagnostics: mcp.diagnostics };
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
    formatExternalWorkspaceForSystemPrompt(settings.external),
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
  externalInspectCache?: ExternalInspectCache;
}): { tools: AgentTool[]; toolBudget: ToolBudgetSnapshot } {
  const tools = createVaultTools(options.app, options.resources.ignoreMatcher, options.readMemo);
  if (options.askUser) tools.push(createAskUserTool(options.askUser));
  tools.push(...createMemoryTools(options.app));
  tools.push(...createDocumentTools(options.app, options.artifactStore));
  if (Platform.isDesktopApp) {
    tools.push(
      ...createExternalWorkspaceTools(options.settings.external, {
        cache: options.externalInspectCache,
        artifactStore: options.artifactStore,
      }),
    );
  }
  tools.push(...createWebTools(options.settings.web, options.webFetch, options.artifactStore));
  tools.push(...createToolArtifactTools(options.artifactStore));
  tools.push(...options.resources.mcpTools);
  tools.push(createReadSkillTool(options.resources.skills));
  if (options.subagentTool) tools.push(options.subagentTool);
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

async function loadRuntimeSkills(app: App, settings: AgenticChatSettings): Promise<Skill[]> {
  // One skill concept: load the skills folder plus the deprecated templates
  // folder (folded in as skills, by name, skills folder winning on conflict).
  const skills = await loadVaultSkills(app, settings.skillsFolder);
  const legacyTemplates = settings.templatesFolder ? await loadVaultSkills(app, settings.templatesFolder) : [];
  const byName = new Map<string, Skill>();
  // Vault skills win over built-ins of the same name (added last, kept-first map).
  for (const skill of [...skills, ...legacyTemplates, ...builtinSkills(settings.web.enabled)]) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()];
}
