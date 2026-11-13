import { describe, expect, it, vi } from "vitest";
import { freshChatTabState, resetChatTabState, stagePromptContext } from "../src/ui/chat-tab-state";

describe("freshChatTabState", () => {
  it("creates the default per-tab UI state", () => {
    const state = freshChatTabState();
    expect(state).toMatchObject({
      attachments: [],
      activeNoteSuppressed: false,
      draft: "",
      queuedPromptArmed: false,
      notifiedCost: false,
      lastCompactionCount: 0,
      lastSentPrompt: null,
      lastSentDisplay: null,
    });
    expect(state.history.entries()).toEqual([]);
  });

  it("does not share mutable collections across tabs", () => {
    const first = freshChatTabState();
    const second = freshChatTabState();

    first.attachments.push("A.md");
    first.history.record("hello");
    first.notifiedContext.add(0.75);

    expect(second.attachments).toEqual([]);
    expect(second.history.entries()).toEqual([]);
    expect([...second.notifiedContext]).toEqual([]);
  });
});

describe("resetChatTabState", () => {
  it("resets only the selected parts and keeps the sent history", () => {
    const state = freshChatTabState();
    state.attachments.push("A.md");
    state.activeNoteSuppressed = true;
    state.lastSentPrompt = "context\n\nhello";
    state.lastSentDisplay = "hello";
    state.history.record("hello");
    const contextCache = state.contextCache;

    resetChatTabState(state, { attachments: true, lastSent: true, history: true });

    expect(state.attachments).toEqual([]);
    expect(state.lastSentPrompt).toBeNull();
    expect(state.lastSentDisplay).toBeNull();
    expect(state.activeNoteSuppressed).toBe(true);
    expect(state.contextCache).toBe(contextCache);
    expect(state.history.entries()).toEqual(["hello"]);
  });
});

describe("stagePromptContext", () => {
  it("settles the caches it captured, not the ones a session reset installed", () => {
    const state = freshChatTabState();
    state.attachments.push("A.md");
    const staged = stagePromptContext(state, "Active.md");
    const commitNote = vi.spyOn(staged.activeNoteCache, "commitPending");
    const commitContext = vi.spyOn(staged.contextCache, "commit");

    // A session reset mid-send swaps the tab's caches and attachments.
    resetChatTabState(state, { attachments: true, activeNoteCache: true, contextCache: true });
    staged.settle(true);

    expect(staged.attachments).toEqual(["A.md"]);
    expect(staged.autoPath).toBe("Active.md");
    expect(commitNote).toHaveBeenCalledTimes(1);
    expect(commitContext).toHaveBeenCalledTimes(1);
    expect(state.activeNoteCache).not.toBe(staged.activeNoteCache);
  });

  it("discards staged context when the turn never reached the transcript", () => {
    const staged = stagePromptContext(freshChatTabState(), null);
    const discardNote = vi.spyOn(staged.activeNoteCache, "discardPending");
    const discardContext = vi.spyOn(staged.contextCache, "discard");
    const commitContext = vi.spyOn(staged.contextCache, "commit");

    staged.settle(false);

    expect(discardNote).toHaveBeenCalledTimes(1);
    expect(discardContext).toHaveBeenCalledTimes(1);
    expect(commitContext).not.toHaveBeenCalled();
  });
});
