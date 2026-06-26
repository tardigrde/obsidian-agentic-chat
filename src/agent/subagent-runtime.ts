import type { App } from "obsidian";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { activeModelConfig, apiKeyForProvider } from "../settings";
import type { AgenticChatSettings } from "../settings";
import { buildModel, type ModelConfig } from "../llm/models";
import { MUTATING_TOOLS } from "../tools/tool-contracts";
import { createVaultTools } from "../tools/vault-tools";
import { createSubagentTool } from "../tools/subagent-tool";
import { ReadMemo } from "../vault/read-memo";
import { resolveModePolicy } from "./modes";
import type { AgentRuntimeResources } from "./runtime-resources";
import type { AgentProfile } from "./subagents";

export interface SubagentRuntimeOptions {
  app: App;
  getSettings: () => AgenticChatSettings;
  getResources: () => AgentRuntimeResources;
  buildStreamFn: () => StreamFn;
  recordUsage: (usage: Usage) => void;
}

/**
 * Builds the parent `subagent` tool and the isolated child agents it dispatches.
 * Parent approval happens outside this runtime; children receive a pre-filtered
 * tool set so they cannot bypass the parent's mode/per-tool denies.
 */
export class AgentSubagentRuntime {
  private readonly app: App;
  private readonly getSettings: () => AgenticChatSettings;
  private readonly getResources: () => AgentRuntimeResources;
  private readonly buildStreamFn: () => StreamFn;
  private readonly recordUsage: (usage: Usage) => void;

  constructor(options: SubagentRuntimeOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    this.getResources = options.getResources;
    this.buildStreamFn = options.buildStreamFn;
    this.recordUsage = options.recordUsage;
  }

  createTool(): AgentTool {
    return createSubagentTool({
      getProfiles: () => this.getResources().profiles,
      createChildAgent: (profile) => this.createChildAgent(profile),
      recordUsage: this.recordUsage,
      defaultConcurrency: 3,
    });
  }

  createChildAgent(profile: AgentProfile): Agent {
    const settings = this.getSettings();
    const readOnly = settings.mode === "plan";
    // Children run without a per-call gate, so a tool the user explicitly denied
    // (per-tool "deny") must be stripped here. resolveModePolicy gives the same
    // precedence the parent gate uses (plan > yolo > per-tool override > default).
    const allowedVaultTools = createVaultTools(this.app, this.getResources().ignoreMatcher, new ReadMemo()).filter(
      (tool) => resolveModePolicy(settings.mode, settings.approval, tool.name).policy !== "deny",
    );
    const tools = filterChildTools(allowedVaultTools, profile.toolAllowlist ?? [], readOnly);
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
      // gate: the user already approved the dispatch.
      toolExecution: "sequential",
    });
  }
}

/** Resolve the model config for a child, overriding only the model id when given. */
export function childModelConfig(settings: AgenticChatSettings, modelOverride?: string): ModelConfig {
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
