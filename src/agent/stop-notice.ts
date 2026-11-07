import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Model fields needed to shape a synthetic assistant message. */
export interface StopNoticeModel {
  api?: AssistantMessage["api"];
  provider?: string;
  id?: string;
}

/**
 * Synthetic assistant message that carries a guard stop reason. Same shape as
 * replay turns, so the chat bubble and JSONL rehydration render it normally.
 */
export function buildStopNoticeMessage(text: string, model?: StopNoticeModel): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model?.api ?? "openai-completions",
    provider: model?.provider ?? "openrouter",
    model: model?.id ?? "unknown",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
