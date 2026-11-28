import type { Plugin } from "obsidian";
import type { AgentService } from "./agent/agent-service";
import type { AgentMode } from "./agent/modes";
import type { ToolApprovalRequest, UserApprovalChoice } from "./agent/tool-call-controller";
import type { McpOAuthCallbackReceiver } from "./mcp/oauth";
import type { PluginService } from "./plugins/service";
import type { AgenticChatSettings } from "./settings-schema";
import type { SettingsStore } from "./settings-store";
import type { AskUserHandler } from "./tools/ask-user-tool";

/**
 * What the chat view, settings tab, and slash handlers need from the plugin.
 * They used to import the concrete class from `main.ts`, which made every
 * `main.ts > ui/* > main.ts` edge a cycle. The entry point satisfies this
 * structurally; the consumers depend on the interface instead (#438).
 */
export interface AgenticChatHost extends Plugin {
  /** The live settings object, owned by {@link settingsStore}. */
  settings: AgenticChatSettings;
  readonly settingsStore: SettingsStore;
  readonly pluginService: PluginService;
  createAgentService(options?: {
    askUser?: AskUserHandler;
    confirmToolCall?: (request: ToolApprovalRequest, signal?: AbortSignal) => Promise<UserApprovalChoice>;
  }): AgentService;
  createMcpOAuthCallbackReceiver(): McpOAuthCallbackReceiver;
  isAnyViewStreaming(): boolean;
  /** The shared runtime mode. Safe at every start; never persisted. */
  readonly mode: AgentMode;
  /** Apply a validated Safe ↔ YOLO change; returns false when it did not change. */
  setMode(target: AgentMode): boolean;
  onModeChange(listener: (mode: AgentMode) => void): () => void;
}
