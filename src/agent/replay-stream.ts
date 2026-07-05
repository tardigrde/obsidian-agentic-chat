import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type StopReason,
  type ToolCall,
  type Usage,
} from "@earendil-works/pi-ai";

export type ReplayStopReason = Extract<StopReason, "stop" | "length" | "toolUse" | "error" | "aborted">;

export interface ReplayUsage extends Partial<Omit<Usage, "cost">> {
  cost?: Partial<Usage["cost"]>;
}

export interface ReplayTurn {
  /** Optional human label for the scripted turn, useful in failing replay assertions. */
  label?: string;
  content: AssistantMessage["content"];
  stopReason?: ReplayStopReason;
  errorMessage?: string;
  usage?: ReplayUsage;
  timestamp?: number;
  /** Emit text/tool-call update events instead of only start + done/error. */
  emitUpdates?: boolean;
  /** Delay before the terminal done/error event. */
  delayMs?: number;
  /** Delay between update events when emitUpdates is enabled. */
  updateDelayMs?: number;
}

export interface ReplayStreamCall {
  index: number;
  label?: string;
  model: string;
  provider: string;
  api: string;
  systemPrompt: string;
  messageCount: number;
  toolNames: string[];
}

export interface ReplayStreamOptions {
  /**
   * What to do when the agent asks for more turns than scripted.
   * "error" catches drift; "repeat-last" preserves older terse unit-test behavior.
   */
  missingTurn?: "error" | "repeat-last";
  /** Start replaying from this absolute turn index. Used when a harness rebuilds the stream function mid-session. */
  initialTurnIndex?: number;
  now?: () => number;
  onCall?: (call: ReplayStreamCall) => void;
}

export interface ReplayStreamController {
  streamFn: StreamFn;
  readonly calls: ReplayStreamCall[];
  remainingTurns: () => number;
}

export function createReplayStreamController(
  turns: readonly ReplayTurn[],
  options: ReplayStreamOptions = {},
): ReplayStreamController {
  let nextTurn = Math.max(0, options.initialTurnIndex ?? 0);
  const calls: ReplayStreamCall[] = [];
  const now = options.now ?? (() => Date.now());

  const streamFn: StreamFn = ((model, context) => {
    const stream = createAssistantMessageEventStream();
    const callIndex = nextTurn;
    const scripted = selectTurn(turns, callIndex, options.missingTurn ?? "error");
    nextTurn += 1;

    const call: ReplayStreamCall = {
      index: callIndex,
      label: scripted?.label,
      model: model.id,
      provider: model.provider,
      api: model.api,
      systemPrompt: context.systemPrompt ?? "",
      messageCount: context.messages.length,
      toolNames: (context.tools ?? []).map((tool) => tool.name),
    };
    calls.push(call);
    options.onCall?.(call);

    const message = scripted
      ? createReplayAssistantMessage(model, scripted, now)
      : createMissingReplayTurnMessage(model, callIndex, now);

    queueMicrotask(() => {
      void emitReplayTurn(stream, message, scripted);
    });
    return stream;
  }) as StreamFn;

  return {
    streamFn,
    calls,
    remainingTurns: () => Math.max(turns.length - nextTurn, 0),
  };
}

export function createReplayStreamFn(turns: readonly ReplayTurn[], options?: ReplayStreamOptions): StreamFn {
  return createReplayStreamController(turns, options).streamFn;
}

export function replayTextTurn(text: string, options: Omit<ReplayTurn, "content"> = {}): ReplayTurn {
  return { ...options, content: [{ type: "text", text }], stopReason: options.stopReason ?? "stop" };
}

export function replayToolCallTurn(
  id: string,
  name: string,
  args: Record<string, unknown>,
  options: Omit<ReplayTurn, "content"> = {},
): ReplayTurn {
  return {
    ...options,
    content: [{ type: "toolCall", id, name, arguments: cloneJsonObject(args) }],
    stopReason: options.stopReason ?? "toolUse",
  };
}

export function replayErrorTurn(errorMessage: string, options: Omit<ReplayTurn, "content" | "stopReason"> = {}): ReplayTurn {
  return { ...options, content: [], stopReason: "error", errorMessage };
}

function selectTurn(
  turns: readonly ReplayTurn[],
  callIndex: number,
  missingTurn: Required<ReplayStreamOptions>["missingTurn"],
): ReplayTurn | undefined {
  const turn = turns[callIndex];
  if (turn || missingTurn === "error") return turn;
  return turns[turns.length - 1];
}

function createReplayAssistantMessage(
  model: Parameters<StreamFn>[0],
  turn: ReplayTurn,
  now: () => number,
): AssistantMessage {
  const content = cloneContent(turn.content);
  const stopReason = turn.stopReason ?? (content.some((block) => block.type === "toolCall") ? "toolUse" : "stop");
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: replayUsage(turn.usage),
    stopReason,
    errorMessage: turn.errorMessage,
    timestamp: turn.timestamp ?? now(),
  };
}

function createMissingReplayTurnMessage(
  model: Parameters<StreamFn>[0],
  callIndex: number,
  now: () => number,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: replayUsage(),
    stopReason: "error",
    errorMessage: `No scripted replay stream turn at index ${callIndex}.`,
    timestamp: now(),
  };
}

async function emitReplayTurn(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  message: AssistantMessage,
  turn: ReplayTurn | undefined,
): Promise<void> {
  const partial: AssistantMessage = { ...message, content: [] };
  stream.push({ type: "start", partial });
  if (turn?.emitUpdates) {
    await emitContentUpdates(stream, partial, message.content, turn.updateDelayMs ?? 0);
  }
  await wait(turn?.delayMs ?? 0);
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: message.stopReason, message });
  }
  stream.end(message);
}

async function emitContentUpdates(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  partial: AssistantMessage,
  content: AssistantMessage["content"],
  updateDelayMs: number,
): Promise<void> {
  for (const block of content) {
    if (block.type === "text") {
      const contentIndex = partial.content.length;
      const partialBlock = { type: "text" as const, text: "" };
      partial.content.push(partialBlock);
      stream.push({ type: "text_start", contentIndex, partial: cloneAssistant(partial) });
      await wait(updateDelayMs);
      partialBlock.text = block.text;
      stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: cloneAssistant(partial) });
      await wait(updateDelayMs);
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: cloneAssistant(partial) });
      await wait(updateDelayMs);
      continue;
    }
    if (block.type === "thinking") {
      const contentIndex = partial.content.length;
      const partialBlock = { type: "thinking" as const, thinking: "" };
      partial.content.push(partialBlock);
      stream.push({ type: "thinking_start", contentIndex, partial: cloneAssistant(partial) });
      await wait(updateDelayMs);
      partialBlock.thinking = block.thinking;
      stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial: cloneAssistant(partial) });
      await wait(updateDelayMs);
      stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: cloneAssistant(partial) });
      await wait(updateDelayMs);
      continue;
    }
    const contentIndex = partial.content.length;
    const partialBlock: ToolCall = {
      type: "toolCall",
      id: block.id,
      name: block.name,
      arguments: {},
    };
    partial.content.push(partialBlock);
    stream.push({ type: "toolcall_start", contentIndex, partial: cloneAssistant(partial) });
    await wait(updateDelayMs);
    const delta = JSON.stringify(block.arguments ?? {});
    partialBlock.arguments = cloneJsonObject(block.arguments);
    stream.push({ type: "toolcall_delta", contentIndex, delta, partial: cloneAssistant(partial) });
    await wait(updateDelayMs);
    stream.push({ type: "toolcall_end", contentIndex, toolCall: cloneToolCall(partialBlock), partial: cloneAssistant(partial) });
    await wait(updateDelayMs);
  }
}

function cloneAssistant(message: AssistantMessage): AssistantMessage {
  return { ...message, content: cloneContent(message.content), usage: replayUsage(message.usage) };
}

function cloneContent(content: AssistantMessage["content"]): AssistantMessage["content"] {
  return content.map((block) => {
    if (block.type === "toolCall") return cloneToolCall(block);
    return { ...block };
  });
}

function cloneToolCall(block: ToolCall): ToolCall {
  return {
    type: "toolCall",
    id: block.id,
    name: block.name,
    arguments: cloneJsonObject(block.arguments),
  };
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function replayUsage(usage: ReplayUsage = {}): Usage {
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    totalTokens: usage.totalTokens ?? ((usage.input ?? 0) + (usage.output ?? 0)),
    cost: {
      input: usage.cost?.input ?? 0,
      output: usage.cost?.output ?? 0,
      cacheRead: usage.cost?.cacheRead ?? 0,
      cacheWrite: usage.cost?.cacheWrite ?? 0,
      total: usage.cost?.total ?? 0,
    },
  };
}

function wait(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => window.setTimeout(resolve, ms)) : Promise.resolve();
}
