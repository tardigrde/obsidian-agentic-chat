import type { App } from "obsidian";
import { Agent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { Platform } from "obsidian";
import type { Usage } from "@earendil-works/pi-ai";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import { activeModelConfig, apiKeyForProvider } from "../settings";
import type { AgenticChatSettings } from "../settings";
import { buildModel, type ModelConfig } from "../llm/models";
import { MUTATING_TOOLS } from "../tools/tool-contracts";
import { createVaultTools } from "../tools/vault-tools";
import { createSubagentTool } from "../tools/subagent-tool";
import { createWebTools } from "../tools/web-tools";
import type { WebFetcher } from "../tools/web-fetch";
import { createToolArtifactTools } from "../artifacts/tool-artifact-tools";
import { createExternalWorkspaceTools } from "../tools/external-workspace";
import { ReadMemo } from "../vault/read-memo";
import { resolveModePolicy } from "./modes";
import type { AgentRuntimeResources } from "./runtime-resources";
import type { AgentProfile } from "./subagents";
import type { AfterToolCallContext, AgentToolCallController, BeforeToolCallContext } from "./tool-call-controller";

export interface SubagentRuntimeOptions {
  app: App;
  getSettings: () => AgenticChatSettings;
  getResources: () => AgentRuntimeResources;
  buildStreamFn: () => StreamFn;
  recordUsage: (usage: Usage) => void;
  webFetch: WebFetcher;
  artifactStore?: ToolArtifactStoreLike;
  toolCalls: Pick<AgentToolCallController, "beforeToolCall" | "afterToolCall">;
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
  private readonly webFetch: WebFetcher;
  private readonly artifactStore: ToolArtifactStoreLike | undefined;
  private readonly toolCalls: Pick<AgentToolCallController, "beforeToolCall" | "afterToolCall">;
  private childNamespaceCounter = 0;

  constructor(options: SubagentRuntimeOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    this.getResources = options.getResources;
    this.buildStreamFn = options.buildStreamFn;
    this.recordUsage = options.recordUsage;
    this.webFetch = options.webFetch;
    this.artifactStore = options.artifactStore;
    this.toolCalls = options.toolCalls;
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
    const childNamespace = this.nextChildNamespace();
    // Strip tools the user explicitly denied before the child is created.
    // Allowed child calls still flow through the parent tool-call controller.
    const childTools = [
      ...createVaultTools(this.app, this.getResources().ignoreMatcher, new ReadMemo()),
      ...(Platform.isDesktopApp
        ? createExternalWorkspaceTools(settings.external, { artifactStore: this.artifactStore })
        : []),
      ...createWebTools(settings.web, this.webFetch, this.artifactStore),
      ...createToolArtifactTools(this.artifactStore),
    ].filter(
      (tool) => resolveModePolicy(settings.mode, settings.approval, tool.name).policy !== "deny",
    );
    const tools = filterChildTools(childTools, profile.toolAllowlist ?? [], readOnly);
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
      beforeToolCall: (context) => this.toolCalls.beforeToolCall(namespaceBeforeToolCall(context, childNamespace)),
      afterToolCall: (context) => this.toolCalls.afterToolCall(namespaceAfterToolCall(context, childNamespace)),
      toolExecution: "sequential",
    });
  }

  private nextChildNamespace(): string {
    this.childNamespaceCounter += 1;
    return `subagent:${this.childNamespaceCounter}`;
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

function namespaceBeforeToolCall(context: BeforeToolCallContext, namespace: string): BeforeToolCallContext {
  return { ...context, toolCall: { ...context.toolCall, id: namespacedToolCallId(namespace, context.toolCall.id) } };
}

function namespaceAfterToolCall(context: AfterToolCallContext, namespace: string): AfterToolCallContext {
  return { ...context, toolCall: { ...context.toolCall, id: namespacedToolCallId(namespace, context.toolCall.id) } };
}

function namespacedToolCallId(namespace: string, id: string): string {
  return `${namespace}:${id}`;
}
