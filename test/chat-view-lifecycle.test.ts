import { describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/ui/chat-view";
import { ActiveNoteContextCache } from "../src/ui/active-note";

describe("ChatView async lifecycle", () => {
  it("does not touch active tab service after the view closes during send", async () => {
    const view = Object.assign(Object.create(ChatView.prototype), {
      app: {},
      attachments: [],
      activeNotePath: null,
      activeNoteSuppressed: false,
      activeNoteCache: new ActiveNoteContextCache(),
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
  sendPrompt: (prompt: string, images: unknown[]) => Promise<void>;
}

interface ChatViewHarness {
  tabs: Array<{ service: FakeService }>;
  closed: boolean;
  sendPrompt: (text: string) => Promise<void>;
  showServiceError: ReturnType<typeof vi.fn>;
}
