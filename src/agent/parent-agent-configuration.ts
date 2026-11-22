import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { apiKeyForProvider, type AgenticChatSettings } from "../settings-schema";
import type { AgentConversation, ParentAgentConfiguration } from "./conversation";
import type { AgentRuntimeResourceState } from "./runtime-resource-state";
import type { AgentStreamRuntime } from "./stream-runtime";
import type { AgentSubagentRuntime } from "./subagent-runtime";
import type { AgentToolCallController } from "./tool-call-controller";
import type { AgentTurnConfiguration } from "./turn-configuration";
import type { AgentLoopGuard } from "./loop-guard";

export interface AgentParentConfigurationOptions {
  getSettings: () => AgenticChatSettings;
  streams: Pick<AgentStreamRuntime, "buildStreamFn">;
  turns: Pick<AgentTurnConfiguration, "buildModelForTurn" | "getActiveModelId" | "thinkingLevelForTurn">;
  runtimeResources: Pick<
    AgentRuntimeResourceState,
    "buildParentTools" | "composeSystemPrompt" | "getProfiles" | "toolsForNextStep"
  >;
  subagents: Pick<AgentSubagentRuntime, "createTool">;
  toolCalls: Pick<
    AgentToolCallController,
    "afterToolCall" | "beforeToolCall" | "consumeStopRequested"
  >;
  loopGuard: Pick<AgentLoopGuard, "finishTurn">;
  sessions: Pick<AgentConversation, "info">;
  onEvent: (event: AgentEvent) => Promise<void> | void;
}

/**
 * Owns the live parent Agent's per-turn configuration: stream function, model,
 * system prompt, registered tools, approval hooks, and active session id.
 */
export class AgentParentConfigurationRuntime {
  constructor(private readonly options: AgentParentConfigurationOptions) {}

  build(): ParentAgentConfiguration {
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
      tools: this.options.runtimeResources.buildParentTools(settings, subagentTool),
      getApiKey: (provider) => apiKeyForProvider(this.options.getSettings(), provider),
      beforeToolCall: (context, signal) => this.options.toolCalls.beforeToolCall(context, signal),
      afterToolCall: (context) => this.options.toolCalls.afterToolCall(context),
      // `finishTurn` also receives the run's abort signal; the guard does not
      // need it, so it is intentionally left unbound. A stopped approval always
      // ends the turn, even when pi replaced the denial with an abort result.
      finishTurn: (turn) => {
        if (this.options.toolCalls.consumeStopRequested()) return { action: "end" as const };
        return this.options.loopGuard.finishTurn(turn);
      },
      toolsForNextStep: (turn) =>
        this.options.runtimeResources.toolsForNextStep(turn.context.tools ?? [], turn.toolResults),
      sessionId: this.options.sessions.info?.id,
      onEvent: (event) => this.options.onEvent(event),
    };
  }
}
