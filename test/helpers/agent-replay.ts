import type { App } from "obsidian";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { AgentService } from "../../src/agent/agent-service";
import {
  createReplayStreamController,
  type ReplayStreamCall,
  type ReplayTurn,
} from "../../src/agent/replay-stream";
import { ObsidianSessionManager } from "../../src/session/session-manager";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../../src/settings";
import { MemoryAdapter } from "./memory-adapter";

export interface AgentReplayOptions {
  turns: readonly ReplayTurn[];
  prompt?: string;
  settings?: Partial<AgenticChatSettings>;
  app?: App;
  confirmToolCall?: () => Promise<boolean>;
}

export interface AgentReplayResult {
  service: AgentService;
  adapter: MemoryAdapter;
  settings: AgenticChatSettings;
  calls: ReplayStreamCall[];
  events: AgentEvent[];
  messages: AgentMessage[];
  sessionText: string;
}

export async function runAgentReplay(options: AgentReplayOptions): Promise<AgentReplayResult> {
  const settings: AgenticChatSettings = {
    ...DEFAULT_SETTINGS,
    openrouterApiKey: "test-key",
    ...options.settings,
    approval: { ...DEFAULT_SETTINGS.approval, ...(options.settings?.approval ?? {}) },
    web: { ...DEFAULT_SETTINGS.web, ...(options.settings?.web ?? {}) },
  };
  const adapter = new MemoryAdapter();
  const sessionManager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
  const replay = createReplayStreamController(options.turns, { missingTurn: "error" });
  const service = new AgentService({
    app: options.app ?? minimalApp(),
    getSettings: () => settings,
    sessionManager,
    confirmToolCall: options.confirmToolCall ?? (async () => true),
    streamFn: replay.streamFn,
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
    calls: replay.calls,
    events,
    messages: service.getMessages(),
    sessionText,
  };
}

function minimalApp(): App {
  return { vault: { on: () => ({}), offref: () => {} }, workspace: {} } as unknown as App;
}
