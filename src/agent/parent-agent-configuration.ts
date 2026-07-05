import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { apiKeyForProvider, type AgenticChatSettings } from "../settings";
import type { AgentActiveSessionRuntime } from "./active-session-runtime";
import type { ParentAgentRuntime, ParentAgentRuntimeConfiguration } from "./parent-agent-runtime";
import type { AgentRuntimeResourceState } from "./runtime-resource-state";
import type { AgentStreamRuntime } from "./stream-runtime";
import type { AgentSubagentRuntime } from "./subagent-runtime";
import type { AgentToolCallController } from "./tool-call-controller";
import type { AgentTurnConfiguration } from "./turn-configuration";

export interface AgentParentConfigurationOptions {
  getSettings: () => AgenticChatSettings;
  streams: Pick<AgentStreamRuntime, "buildStreamFn">;
  turns: Pick<AgentTurnConfiguration, "buildModelForTurn" | "getActiveModelId" | "thinkingLevelForTurn">;
  runtimeResources: Pick<
    AgentRuntimeResourceState,
    "buildParentTools" | "composeSystemPrompt" | "getProfiles" | "reload"
  >;
  subagents: Pick<AgentSubagentRuntime, "createTool">;
  toolCalls: Pick<AgentToolCallController, "afterToolCall" | "beforeToolCall">;
  sessions: Pick<AgentActiveSessionRuntime, "ensureConfiguration" | "info">;
  onEvent: (event: AgentEvent) => Promise<void> | void;
}

/**
 * Owns the live parent Agent's per-turn configuration: stream function, model,
 * system prompt, registered tools, approval hooks, and active session id.
 */
export class AgentParentConfigurationRuntime {
  constructor(private readonly options: AgentParentConfigurationOptions) {}

  build(): ParentAgentRuntimeConfiguration {
    const settings = this.options.getSettings();
    const model = this.options.turns.buildModelForTurn(settings);
    const subagentTool =
      this.options.runtimeResources.getProfiles().length > 0
        ? this.options.subagents.createTool()
        : undefined;
    return {
      streamFn: this.options.streams.buildStreamFn(),
      systemPrompt: this.options.runtimeResources.composeSystemPrompt(
        settings,
        this.options.turns.getActiveModelId(),
      ),
      model,
      thinkingLevel: this.options.turns.thinkingLevelForTurn(settings),
      tools: this.options.runtimeResources.buildParentTools(settings, subagentTool, {
        contextWindow: model.contextWindow,
      }),
      getApiKey: (provider) => apiKeyForProvider(this.options.getSettings(), provider),
      beforeToolCall: (context) => this.options.toolCalls.beforeToolCall(context),
      afterToolCall: (context) => this.options.toolCalls.afterToolCall(context),
      sessionId: this.options.sessions.info?.id,
      onEvent: (event) => this.options.onEvent(event),
    };
  }

  async refresh(parentAgent: ParentAgentRuntime): Promise<void> {
    parentAgent.requireAgent();
    await this.options.runtimeResources.reload();
    parentAgent.refreshConfiguration();
    await this.options.sessions.ensureConfiguration();
  }
}
