import { describe, expect, it, vi } from "vitest";
import type { ChatTabWorkingState } from "../src/ui/chat-tab-state";
import { chatTab, chatViewHarness } from "./helpers/chat-view-harness";

interface TabsHarness {
  tabs: Array<{ state: ChatTabWorkingState }>;
  activeTabIndex: number;
  inputEl: { value: string; setSelectionRange: () => void };
  pushAttachment: (entry: string) => boolean;
  queueComposerPrompt: () => void;
  switchToTab: (index: number) => Promise<void>;
}

function twoTabView(): TabsHarness {
  const service = { isPathIgnored: () => false };
  return chatViewHarness<TabsHarness>({
    tabs: [chatTab(service), chatTab(service)],
    inputEl: { value: "", setSelectionRange: vi.fn() },
    statusEl: { setText: vi.fn() },
    menu: { hide: vi.fn() },
    cancelAutocomplete: vi.fn(),
    renderChips: vi.fn(),
    syncChrome: vi.fn(),
    renderActiveTab: vi.fn(),
  });
}

describe("ChatView tabs", () => {
  it("writes composer state straight into the active tab, with no save step", () => {
    const view = twoTabView();

    view.pushAttachment("Notes/A.md");
    view.queueComposerPrompt();

    expect(view.tabs[0].state.attachments).toEqual(["Notes/A.md"]);
    expect(view.tabs[0].state.queuedPromptArmed).toBe(true);
    expect(view.tabs[1].state.attachments).toEqual([]);
    expect(view.tabs[1].state.queuedPromptArmed).toBe(false);
  });

  it("parks the draft on a switch and keeps each tab's attachments apart", async () => {
    const view = twoTabView();
    view.inputEl.value = "draft in tab one";
    view.pushAttachment("Notes/A.md");

    await view.switchToTab(1);
    expect(view.inputEl.value).toBe("");
    expect(view.tabs[0].state.draft).toBe("draft in tab one");
    view.pushAttachment("Notes/B.md");

    await view.switchToTab(0);
    expect(view.inputEl.value).toBe("draft in tab one");
    expect(view.tabs[0].state.attachments).toEqual(["Notes/A.md"]);
    expect(view.tabs[1].state.attachments).toEqual(["Notes/B.md"]);
  });
});

describe("ChatView.closeTab", () => {
  function closableTab() {
    const service = { isPathIgnored: () => false, dispose: vi.fn() };
    const tab = { ...chatTab(service), unsubscribe: vi.fn(), pendingApprovalModal: { close: vi.fn() } };
    return { tab, service };
  }

  function viewWith(tabs: unknown[], activeTabIndex: number) {
    return chatViewHarness<{
      tabs: unknown[];
      activeTabIndex: number;
      closeTab: (index: number) => void;
    }>({ tabs, activeTabIndex, startNewConversation: vi.fn(async () => {}) });
  }

  it("closes a background tab's pending approval and disposes its session", () => {
    const active = closableTab();
    const background = closableTab();
    const view = viewWith([active.tab, background.tab], 0);

    view.closeTab(1);

    expect(background.tab.pendingApprovalModal.close).toHaveBeenCalledTimes(1);
    expect(background.tab.unsubscribe).toHaveBeenCalledTimes(1);
    expect(background.service.dispose).toHaveBeenCalledTimes(1);
    expect(view.tabs).toEqual([active.tab]);
    expect(view.activeTabIndex).toBe(0);
    expect(active.service.dispose).not.toHaveBeenCalled();
  });

  it("keeps the same tab active when a tab before it closes", () => {
    const first = closableTab();
    const second = closableTab();
    const view = viewWith([first.tab, second.tab], 1);

    view.closeTab(0);

    expect(view.tabs).toEqual([second.tab]);
    expect(view.activeTabIndex).toBe(0);
  });

  it("starts a new conversation instead of closing the only tab", () => {
    const only = closableTab();
    const view = viewWith([only.tab], 0) as unknown as {
      closeTab: (index: number) => void;
      tabs: unknown[];
      startNewConversation: ReturnType<typeof vi.fn>;
    };

    view.closeTab(0);

    expect(view.startNewConversation).toHaveBeenCalledTimes(1);
    expect(only.service.dispose).not.toHaveBeenCalled();
    expect(view.tabs).toHaveLength(1);
  });
});
