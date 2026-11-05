import { describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/ui/chat-view";
import { ActiveNoteContextCache } from "../src/ui/active-note";
import { PromptContextCache } from "../src/ui/context-builder";

describe("ChatView async lifecycle", () => {
  it("clears an armed queued prompt when the session changes", async () => {
    const sendPrompt = vi.fn(async () => {});
    const view = Object.assign(Object.create(ChatView.prototype), {
      queuedPromptArmed: true,
      flushingQueuedPrompt: false,
      inputEl: { value: "stale queued draft" },
      tabs: [{ service: { isStreaming: () => false, getSessionSwapState: () => "live", sendPrompt } }],
      activeTabIndex: 0,
      statusEl: { setText: vi.fn() },
      renderChips: vi.fn(),
      syncChrome: vi.fn(),
    }) as ChatViewHarness & {
      queuedPromptArmed: boolean;
      statusEl: { setText: ReturnType<typeof vi.fn> };
      renderChips: ReturnType<typeof vi.fn>;
      syncChrome: ReturnType<typeof vi.fn>;
    };

    view.resetSessionUiState({ queuedPrompt: true });
    expect(view.queuedPromptArmed).toBe(false);

    await view.flushQueuedPromptIfReady();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("does not flush a queued prompt while the session swap is not live", async () => {
    const sendPrompt = vi.fn(async () => {});
    const view = Object.assign(Object.create(ChatView.prototype), {
      queuedPromptArmed: true,
      flushingQueuedPrompt: false,
      inputEl: { value: "stale queued draft" },
      tabs: [
        {
          service: {
            isStreaming: () => false,
            getSessionSwapState: () => "activating",
          },
        },
      ],
      activeTabIndex: 0,
      statusEl: { setText: vi.fn() },
      renderChips: vi.fn(),
      syncChrome: vi.fn(),
      composerHistory: { record: vi.fn() },
      sendPrompt,
    }) as ChatViewHarness & {
      queuedPromptArmed: boolean;
      flushQueuedPromptIfReady: () => Promise<void>;
    };

    await view.flushQueuedPromptIfReady();

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(view.queuedPromptArmed).toBe(true);
  });

  it("flushes the queued prompt once the session swap is live", async () => {
    const sendPrompt = vi.fn(async () => {});
    const view = Object.assign(Object.create(ChatView.prototype), {
      queuedPromptArmed: true,
      flushingQueuedPrompt: false,
      inputEl: { value: "queued draft" },
      tabs: [
        {
          service: {
            isStreaming: () => false,
            getSessionSwapState: () => "live",
          },
        },
      ],
      activeTabIndex: 0,
      statusEl: { setText: vi.fn() },
      renderChips: vi.fn(),
      syncChrome: vi.fn(),
      composerHistory: { record: vi.fn() },
      sendPrompt,
    }) as ChatViewHarness & {
      queuedPromptArmed: boolean;
      flushQueuedPromptIfReady: () => Promise<void>;
    };

    await view.flushQueuedPromptIfReady();

    expect(sendPrompt).toHaveBeenCalledWith("queued draft");
    expect(view.queuedPromptArmed).toBe(false);
  });

  it("does not touch active tab service after the view closes during send", async () => {
    const view = Object.assign(Object.create(ChatView.prototype), {
      app: {},
      attachments: [],
      activeNotePath: null,
      activeNoteSuppressed: false,
      activeNoteCache: new ActiveNoteContextCache(),
      contextCache: new PromptContextCache(),
      closed: false,
      activeTabIndex: 0,
      clearEmptyState: vi.fn(),
      renderOutgoingUserMessage: vi.fn(),
      showServiceError: vi.fn(),
    }) as ChatViewHarness;

    const service: FakeService = {
      getMessages: vi.fn(() => []),
      isPathIgnored: vi.fn(() => false),
      supportsImages: vi.fn(() => false),
      sendPrompt: vi.fn(async () => {
        view.closed = true;
        view.tabs = [];
      }),
    };
    view.tabs = [{ service }];

    await expect(view.sendPrompt("hello")).resolves.toBeUndefined();
    expect(view.showServiceError).not.toHaveBeenCalled();
  });
});

interface FakeService {
  getMessages: () => unknown[];
  isPathIgnored: (path: string) => boolean;
  supportsImages: () => boolean;
  getSessionSwapState?: () => string;
  sendPrompt: (prompt: string, images: unknown[]) => Promise<void>;
}

interface ChatViewHarness {
  tabs: Array<{ service: FakeService }>;
  closed: boolean;
  sendPrompt: (text: string) => Promise<void>;
  showServiceError: ReturnType<typeof vi.fn>;
  resetSessionUiState: (options: { queuedPrompt?: boolean }) => void;
  flushQueuedPromptIfReady: () => Promise<void>;
}
