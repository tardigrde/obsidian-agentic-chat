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
    promptEdit: { end: () => ({ ended: false }) },
    cancelAutocomplete: vi.fn(),
    renderChips: vi.fn(),
    syncChrome: vi.fn(),
    renderActiveTab: vi.fn(),
    // Base-tree fields: before tabs owned their state, the view held these.
    // Setting them lets the red run reach the assertions instead of a TypeError.
    attachments: [],
    queuedPromptArmed: false,
    activeNoteSuppressed: false,
    composerHistory: { entries: () => [], load: vi.fn() },
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
