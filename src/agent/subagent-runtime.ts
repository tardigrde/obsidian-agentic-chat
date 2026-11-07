import type { App } from "obsidian";
import { Agent, type AgentTool, type AgentTurnContext, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";
import { activeModelConfig, apiKeyForProvider } from "../settings";
import type { AgenticChatSettings } from "../settings";
import { buildModel, type ModelConfig } from "../llm/models";
import { MUTATING_TOOLS } from "../tools/tool-contracts";
import { createReadSkillFileTool, createReadSkillTool } from "../tools/read-skill-tool";
import { createVaultTools } from "../tools/vault-tools";
import { createSubagentTool, SubagentRegistry } from "../tools/subagent-tool";
import { createWebTools } from "../tools/web-tools";
import type { WebFetcher } from "../tools/web-fetch";
import { createToolArtifactTools } from "../artifacts/tool-artifact-tools";
import { ReadMemo } from "../vault/read-memo";
import { resolveModePolicy } from "./modes";
import { buildStopNoticeMessage } from "./stop-notice";
import type { AgentRuntimeResources } from "./runtime-resources";
import type { AgentRole } from "./subagents";
import type { AfterToolCallContext, AgentToolCallController, BeforeToolCallContext } from "./tool-call-controller";

/** Structural child turn cap, so this runtime does not import the cap module. */
export interface ChildTurnCap {
  readonly noticeText: string | null;
  shouldStopAfterTurn: (turn: AgentTurnContext) => boolean;
}

export interface SubagentRuntimeOptions {
  app: App;
  getSettings: () => AgenticChatSettings;
  getResources: () => AgentRuntimeResources;
  buildStreamFn: () => StreamFn;
  recordUsage: (usage: Usage) => void;
  webFetch: WebFetcher;
  artifactStore?: ToolArtifactStoreLike;
  toolCalls: Pick<AgentToolCallController, "beforeToolCall" | "afterToolCall">;
  /** Build a fresh turn cap for one child dispatch. Omitted means no child cap. */
  createTurnCap?: () => ChildTurnCap;
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
  private readonly createTurnCap: (() => ChildTurnCap) | undefined;
  private childNamespaceCounter = 0;
  /** Per-runtime stop/error state, shared with this runtime's tool-call controller. */
  readonly registry = new SubagentRegistry();

  constructor(options: SubagentRuntimeOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    this.getResources = options.getResources;
    this.buildStreamFn = options.buildStreamFn;
    this.recordUsage = options.recordUsage;
    this.webFetch = options.webFetch;
    this.artifactStore = options.artifactStore;
    this.toolCalls = options.toolCalls;
    this.createTurnCap = options.createTurnCap;
  }

  createTool(): AgentTool {
    return createSubagentTool({
      getProfiles: () => this.getResources().profiles,
      createChildAgent: (profile) => this.createChildAgent(profile),
      recordUsage: this.recordUsage,
      maxRuntimeSeconds: () => this.getSettings().subagentTimeoutSeconds,
      registry: this.registry,
    });
  }

  /** Stop one child dispatched by this runtime; other runtimes are untouched. */
  abortChild(id: string): void {
    this.registry.abort(id);
  }

  createChildAgent(profile: AgentRole): Agent {
    const settings = this.getSettings();
    const childNamespace = this.nextChildNamespace();
    // Strip tools the user explicitly denied before the child is created.
    // Allowed child calls still flow through the parent tool-call controller.
    const skills = this.getResources().skills;
    const childTools = [
      ...createVaultTools(this.app, this.getResources().ignoreMatcher, new ReadMemo()),
      ...createWebTools(settings.web, this.webFetch, this.artifactStore),
      ...createToolArtifactTools(this.artifactStore),
      createReadSkillTool(skills),
      createReadSkillFileTool(this.app, skills),
    ].filter(
      (tool) => resolveModePolicy(settings.mode, settings.approval, tool.name).policy !== "deny",
    );
    const tools = filterChildTools(childTools, profile.toolAllowlist ?? []);
    const turnCap = this.createTurnCap?.();
    const child = new Agent({
      streamFn: this.buildStreamFn(),
      initialState: {
        systemPrompt: profile.systemPrompt,
        model: buildModel(childModelConfig(settings, profile.model)),
        thinkingLevel: settings.thinkingLevel,
        tools,
        messages: [],
      },
      getApiKey: (provider) => apiKeyForProvider(this.getSettings(), provider),
      beforeToolCall: (context, signal) =>
        this.toolCalls.beforeToolCall(namespaceBeforeToolCall(context, childNamespace), signal),
      afterToolCall: (context) => this.toolCalls.afterToolCall(namespaceAfterToolCall(context, childNamespace)),
      toolExecution: "sequential",
    });
    if (turnCap) {
      // A capped child ends gracefully and leaves a plain-text note as its last
      // assistant message, so the parent sees why the child stopped.
      child.finishTurn = (turn) => {
        if (!turnCap.shouldStopAfterTurn(turn)) return undefined;
        const notice = turnCap.noticeText;
        if (notice) child.state.messages.push(buildStopNoticeMessage(notice, child.state.model));
        return { action: "end" as const };
      };
    }
    return child;
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
 * Restrict a child's tools to its role allowlist. An empty allowlist defaults
 * to the read-only vault tools. The allowlist is advisory – parent approval
 * gates still govern execution.
 */
export function filterChildTools(tools: AgentTool[], allowlist: string[]): AgentTool[] {
  // Allowlist entries come from vault frontmatter — normalize case/whitespace
  // so "Read, search" does not silently lobotomise the child to zero tools.
  const normalized = allowlist.map((name) => name.trim().toLowerCase()).filter(Boolean);
  let allowed =
    normalized.length > 0
      ? tools.filter((tool) => normalized.includes(tool.name.toLowerCase()))
      : tools.filter((tool) => !MUTATING_TOOLS.has(tool.name));
  if (normalized.length > 0 && allowed.length === 0) {
    console.warn(
      `Agentic chat: subagent allowlist [${allowlist.join(", ")}] matched no tools — falling back to read-only vault tools.`,
    );
    allowed = tools.filter((tool) => !MUTATING_TOOLS.has(tool.name));
  }
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
