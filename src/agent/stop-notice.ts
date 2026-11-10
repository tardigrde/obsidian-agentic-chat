import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

/** Model fields needed to shape a synthetic assistant message. */
export interface StopNoticeModel {
  api?: AssistantMessage["api"];
  provider?: string;
  id?: string;
}

/** Assistant message written by the harness, not by the model. */
export type StopNoticeMessage = AssistantMessage & { harnessNotice?: true };

/** Text prefixes of guard notices, so sessions saved before the marker still match. */
const STOP_NOTICE_PREFIXES = ["Turn cap: stopped", "Loop guard: stopped"];

/**
 * Synthetic assistant message that carries a guard stop reason. Same shape as
 * replay turns, so the chat bubble and JSONL rehydration render it normally.
 * It is transcript-only: `toLlmMessages` keeps it out of the model context
 * (#283), so the model never reads text it did not write.
 */
export function buildStopNoticeMessage(text: string, model?: StopNoticeModel): StopNoticeMessage {
  return {
    harnessNotice: true,
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

/**
 * True for a guard stop notice: the `harnessNotice` marker, or the legacy
 * shape (one text block with a guard prefix and zero usage) from older JSONL.
 */
export function isStopNoticeMessage(message: AgentMessage): boolean {
  if ((message as { role?: unknown }).role !== "assistant") return false;
  const assistant = message as StopNoticeMessage;
  if (assistant.harnessNotice === true) return true;
  if (assistant.usage?.totalTokens !== 0 || assistant.usage?.output !== 0) return false;
  const content = assistant.content;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const [block] = content;
  if (block?.type !== "text") return false;
  return STOP_NOTICE_PREFIXES.some((prefix) => block.text.startsWith(prefix));
}

/**
 * The parent agent's `convertToLlm`: pi's default role filter, minus guard
 * stop notices. The notice stays in the transcript for the user.
 */
export function toLlmMessages(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (message): message is Message =>
      (message.role === "system" ||
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "toolResult") &&
      !isStopNoticeMessage(message),
  );
}
