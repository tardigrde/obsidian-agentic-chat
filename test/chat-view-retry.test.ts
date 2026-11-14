import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type ImageContent,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { AgentService } from "../src/agent/agent-service";
import { chatViewHarness } from "./helpers/chat-view-harness";
import { ObsidianSessionManager, SessionWriteRegistry } from "../src/session/session-manager";
import { DEFAULT_SETTINGS } from "../src/settings-schema";
import { MemoryAdapter } from "./helpers/memory-adapter";
import type { AskUserHandler } from "../src/tools/ask-user-tool";

const IMAGE: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };

function userMessage(text: string, images: ImageContent[] = []): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }, ...images],
    timestamp: 1,
  } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 2 } as AgentMessage;
}

interface RetryHarness {
  retryLast: () => Promise<void>;
}

function harness(messages: AgentMessage[], sendPrompt: ReturnType<typeof vi.fn>): RetryHarness {
  const service = {
    isStreaming: () => false,
    getMessages: () => messages,
    getSessionToken: () => "session-a",
    sendPrompt,
    getError: () => undefined,
  };
  return chatViewHarness<RetryHarness>({
    service,
    state: { lastSentPrompt: "what is in this picture?", lastSentDisplay: "what is in this picture?" },
    clearEmptyState: vi.fn(),
    renderOutgoingUserMessage: vi.fn(),
    showServiceError: vi.fn(),
  });
}

/** Stream function that records the transcript context handed to the provider. */
function capturingStreamFn(): { streamFn: StreamFn; contexts: TranscriptContext[] } {
  const contexts: TranscriptContext[] = [];
  const streamFn = ((model: Model<"openai-completions">, context: TranscriptContext) => {
    contexts.push(context);
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "A cat." }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  }) as unknown as StreamFn;
  return { streamFn, contexts };
}

/** First call fails with `reason` and no content; later calls answer "A cat.". */
function failingThenOkStreamFn(reason: "error" | "aborted"): { streamFn: StreamFn; contexts: TranscriptContext[] } {
  const contexts: TranscriptContext[] = [];
  const streamFn = ((model: Model<"openai-completions">, context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    const first = contexts.length === 1;
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant" as const,
      content: first ? [] : [{ type: "text" as const, text: "A cat." }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: first ? reason : ("stop" as const),
      ...(first ? { errorMessage: reason === "aborted" ? "Request was aborted." : "boom" } : {}),
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      if (first) stream.push({ type: "error", reason, error: message } as never);
      else stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  }) as unknown as StreamFn;
  return { streamFn, contexts };
}

/** First call runs a tool, second fails with no content, third answers. */
function toolThenFailThenOkStreamFn(reason: "error" | "aborted"): {
  streamFn: StreamFn;
  contexts: TranscriptContext[];
} {
  const contexts: TranscriptContext[] = [];
  const streamFn = ((model: Model<"openai-completions">, context: TranscriptContext) => {
    contexts.push(structuredClone(context));
    const call = contexts.length;
    const stream = createAssistantMessageEventStream();
    const base = {
      role: "assistant" as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: Date.now(),
    };
    if (call === 1) {
      const message = {
        ...base,
        content: [
          {
            type: "toolCall" as const,
            id: "call-1",
            name: "ask_user",
            arguments: { question: "Which folder should I use?", choices: ["Notes"] },
          },
        ],
        stopReason: "toolUse" as const,
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "toolUse", message });
        stream.end(message);
      });
    } else if (call === 2) {
      const message = {
        ...base,
        content: [],
        stopReason: reason,
        errorMessage: reason === "aborted" ? "Request was aborted." : "boom",
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "error", reason, error: message } as never);
        stream.end(message);
      });
    } else {
      const message = {
        ...base,
        content: [{ type: "text" as const, text: "Done." }],
        stopReason: "stop" as const,
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      });
    }
    return stream;
  }) as unknown as StreamFn;
  return { streamFn, contexts };
}

function retryView(service: AgentService): RetryHarness {
  return chatViewHarness<RetryHarness>({
    service,
    state: { lastSentPrompt: null, lastSentDisplay: null },
    bubble: null,
    clearEmptyState: vi.fn(),
    renderTranscript: vi.fn(),
    renderOutgoingUserMessage: vi.fn(),
    showServiceError: vi.fn(),
  });
}

function userTexts(context: TranscriptContext): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
    );
}

function realService(streamFn: StreamFn, askUser?: AskUserHandler): AgentService {
  const settings = { ...DEFAULT_SETTINGS, openrouterApiKey: "test-key" };
  return new AgentService({
    app: { vault: { on: () => ({}), offref: () => {} }, workspace: {} } as unknown as App,
    getSettings: () => settings,
    sessionManager: new ObsidianSessionManager(new MemoryAdapter().asDataAdapter(), "sessions", "vault:test", new SessionWriteRegistry()),
    confirmToolCall: async () => ({ approved: true, remember: false }),
    askUser,
    streamFn,
  });
}

describe("ChatView retry", () => {
  it("keeps the image in the provider context when retrying from history", async () => {
    const { streamFn, contexts } = capturingStreamFn();
    const service = realService(streamFn);
    await service.sendPrompt("what is in this picture?", [IMAGE]);

    const view = chatViewHarness<RetryHarness>({
      service,
      state: { lastSentPrompt: null, lastSentDisplay: null },
      clearEmptyState: vi.fn(),
      renderOutgoingUserMessage: vi.fn(),
      showServiceError: vi.fn(),
    });

    await view.retryLast();

    expect(contexts).toHaveLength(2);
    const lastUser = [...contexts[1].messages].reverse().find((message) => message.role === "user");
    expect(lastUser?.content).toEqual([{ type: "text", text: "what is in this picture?" }, IMAGE]);
  });

  it("resends the last user turn's image blocks", async () => {
    const messages = [userMessage("what is in this picture?", [IMAGE]), assistantMessage("A cat.")];
    const sendPrompt = vi.fn(async () => {});
    const view = harness(messages, sendPrompt);

    await view.retryLast();

    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt).toHaveBeenCalledWith("what is in this picture?", [IMAGE], "session-a");
  });

  it("does not send a retry into a session swapped while truncate is pending", async () => {
    const messages = [
      userMessage("hello"),
      { role: "assistant", content: [], stopReason: "error", timestamp: 2 } as unknown as AgentMessage,
    ];
    let sessionToken = "session-a";
    let finishTruncate: () => void = () => {};
    const truncateMessages = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishTruncate = resolve;
        }),
    );
    const sendPrompt = vi.fn(async () => {});
    const view = chatViewHarness<RetryHarness>({
      service: {
        isStreaming: () => false,
        getMessages: () => messages,
        getSessionToken: () => sessionToken,
        truncateMessages,
        sendPrompt,
        continueTurn: vi.fn(),
        reportSessionChanged: vi.fn(),
        getError: () => undefined,
      },
      state: { lastSentPrompt: "hello", lastSentDisplay: "hello" },
      clearEmptyState: vi.fn(),
      renderTranscript: vi.fn(),
      renderOutgoingUserMessage: vi.fn(),
      showServiceError: vi.fn(),
    });

    const retry = view.retryLast();
    // Retry captured session-a, then the same tab loaded session-b while the
    // transcript rewrite was still in flight.
    sessionToken = "session-b";
    finishTruncate();
    await retry;

    expect(truncateMessages).toHaveBeenCalledTimes(1);
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("does not duplicate or mutate image attachments when retried twice", async () => {
    const messages = [userMessage("what is in this picture?", [IMAGE]), assistantMessage("A cat.")];
    const originalContent = messages[0].content;
    const sendPrompt = vi.fn(async (prompt: string, images?: ImageContent[]) => {
      messages.push(userMessage(prompt, images));
      messages.push(assistantMessage("A cat again."));
    });
    const view = harness(messages, sendPrompt);

    await view.retryLast();
    await view.retryLast();

    expect(sendPrompt).toHaveBeenCalledTimes(2);
    for (const call of sendPrompt.mock.calls) {
      expect(call[1]).toEqual([IMAGE]);
    }
    expect(messages[0].content).toBe(originalContent);
    expect(messages[0].content).toEqual([{ type: "text", text: "what is in this picture?" }, IMAGE]);
  });
  it.each(["error", "aborted"] as const)(
    "sends a failed (%s) turn's prompt once when retried, not twice",
    async (reason) => {
      const { streamFn, contexts } = failingThenOkStreamFn(reason);
      const service = realService(streamFn);
      await service.sendPrompt("queued draft after edit");

      await retryView(service).retryLast();

      expect(contexts).toHaveLength(2);
      expect(userTexts(contexts[1])).toEqual(["queued draft after edit"]);
      expect(contexts[1].messages.some((message) => message.role === "assistant")).toBe(false);
      const roles = service.getMessages().map((message) => message.role);
      expect(roles).toEqual(["user", "assistant"]);
    },
  );

  it.each(["error", "aborted"] as const)(
    "continues a failed (%s) turn after a tool instead of resending the prompt",
    async (reason) => {
      const { streamFn, contexts } = toolThenFailThenOkStreamFn(reason);
      const service = realService(streamFn, async () => "Notes");
      await service.sendPrompt("organize this note");
      const sendPrompt = vi.spyOn(service, "sendPrompt");

      await retryView(service).retryLast();

      expect(sendPrompt).not.toHaveBeenCalled();
      expect(contexts).toHaveLength(3);
      const retried = contexts[2];
      expect(userTexts(retried)).toEqual(["organize this note"]);
      expect(retried.messages.some((message) => message.role === "toolResult")).toBe(true);
      expect(
        retried.messages.some(
          (message) => message.role === "assistant" && (message as { stopReason?: string }).stopReason === reason,
        ),
      ).toBe(false);
      const roles = service.getMessages().map((message) => message.role);
      expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);
      const last = service.getMessages().at(-1) as {
        stopReason?: string;
        content?: Array<{ type: string; text?: string }>;
      };
      expect(last.stopReason).toBe("stop");
      expect((last.content ?? []).map((block) => block.text ?? "").join("")).toBe("Done.");
    },
  );

  it("continues from the kept tool results when a stopped turn has no failed reply", async () => {
    const messages = [
      userMessage("read two files"),
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.md" } }],
        stopReason: "toolUse",
        timestamp: 2,
      } as unknown as AgentMessage,
      { role: "toolResult", content: [{ type: "text", text: "ok" }], timestamp: 3 } as unknown as AgentMessage,
    ];
    const continueTurn = vi.fn(async () => {});
    const sendPrompt = vi.fn(async () => {});
    const truncateMessages = vi.fn(async () => 1);
    const view = chatViewHarness<RetryHarness>({
      service: {
        isStreaming: () => false,
        getMessages: () => messages,
        getSessionToken: () => "session-a",
        continueTurn,
        sendPrompt,
        truncateMessages,
        getError: () => undefined,
      },
      state: { lastSentPrompt: null, lastSentDisplay: null },
      clearEmptyState: vi.fn(),
      renderTranscript: vi.fn(),
      renderOutgoingUserMessage: vi.fn(),
      showServiceError: vi.fn(),
    });

    await view.retryLast();

    expect(continueTurn).toHaveBeenCalledWith("session-a");
    expect(truncateMessages).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("keeps a successful turn when Ask again re-runs it", async () => {
    const { streamFn, contexts } = capturingStreamFn();
    const service = realService(streamFn);
    await service.sendPrompt("hello");

    await retryView(service).retryLast();

    expect(userTexts(contexts[1])).toEqual(["hello", "hello"]);
  });
});
