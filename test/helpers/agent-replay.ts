import type { App } from "obsidian";
import type { AgentEvent, AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { AgentService } from "../../src/agent/agent-service";
import type { ToolApprovalRequest, UserApprovalChoice } from "../../src/agent/tool-call-controller";
import {
  createReplayStreamController,
  type ReplayStreamCall,
  type ReplayTurn,
} from "../../src/agent/replay-stream";
import { ObsidianSessionManager, SessionWriteRegistry } from "../../src/session/session-manager";
import type { AskUserHandler } from "../../src/tools/ask-user-tool";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../../src/settings-schema";
import type { AgentMode } from "../../src/agent/modes";
import { FakeAdapter as MemoryAdapter } from "../support/fake-adapter";

/** Tests may still name `mode` beside settings; the helper routes it to runtime. */
type ReplaySettings = Partial<AgenticChatSettings> & { mode?: AgentMode };

export interface AgentReplayOptions {
  turns: readonly ReplayTurn[];
  prompt?: string;
  settings?: ReplaySettings;
  app?: App;
  confirmToolCall?: (request: ToolApprovalRequest) => Promise<UserApprovalChoice>;
  askUser?: AskUserHandler;
  /** Sees each model request as the provider would: system prompt, messages, tools. */
  onRequest?: (context: Parameters<StreamFn>[1]) => void;
}

export interface AgentReplayResult {
  service: AgentService;
  adapter: MemoryAdapter;
  settings: AgenticChatSettings;
  mode: AgentMode;
  calls: ReplayStreamCall[];
  events: AgentEvent[];
  messages: AgentMessage[];
  sessionText: string;
}

export async function runAgentReplay(options: AgentReplayOptions): Promise<AgentReplayResult> {
  const { mode = "safe", ...settingsOverrides } = options.settings ?? {};
  const settings: AgenticChatSettings = {
    ...DEFAULT_SETTINGS,
    openrouterApiKey: "test-key",
    ...settingsOverrides,
    approval: { ...DEFAULT_SETTINGS.approval, ...(settingsOverrides.approval ?? {}) },
    web: { ...DEFAULT_SETTINGS.web, ...(settingsOverrides.web ?? {}) },
  };
  const adapter = new MemoryAdapter();
  const sessionManager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test", new SessionWriteRegistry());
  const replay = createReplayStreamController(options.turns, { missingTurn: "error" });
  const service = new AgentService({
    app: options.app ?? minimalApp(),
    getSettings: () => settings,
    getMode: () => mode,
    sessionManager,
    confirmToolCall: options.confirmToolCall ?? (async () => ({ approved: true, remember: false })),
    ...(options.askUser ? { askUser: options.askUser } : {}),
    streamFn: options.onRequest
      ? (((model, context, streamOptions) => {
          options.onRequest?.(context);
          return replay.streamFn(model, context, streamOptions);
        }) as StreamFn)
      : replay.streamFn,
  });
  const events: AgentEvent[] = [];
  service.onEvent((event) => {
    events.push(event);
  });

  await service.sendPrompt(options.prompt ?? "run replay");
  const sessionText = [...adapter.files.entries()]
    .filter(([path]) => path.endsWith(".jsonl"))
    .map(([, content]) => content)
    .join("\n");

  return {
    service,
    adapter,
    settings,
    mode,
    calls: replay.calls,
    events,
    messages: service.getMessages(),
    sessionText,
  };
}

function minimalApp(): App {
  return { vault: { on: () => ({}), offref: () => {} }, workspace: {} } as unknown as App;
}
