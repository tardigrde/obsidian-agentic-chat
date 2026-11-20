import { describe, expect, it } from "vitest";
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

    resetChatTabState(state, { attachments: true, lastSent: true, history: true });

    expect(state.attachments).toEqual([]);
    expect(state.lastSentPrompt).toBeNull();
    expect(state.lastSentDisplay).toBeNull();
    expect(state.activeNoteSuppressed).toBe(true);
    expect(state.history.entries()).toEqual(["hello"]);
  });
});

describe("stagePromptContext", () => {
  it("captures the attachments and active note at send time, not after a reset", () => {
    const state = freshChatTabState();
    state.attachments.push("A.md");
    const staged = stagePromptContext(state, "Active.md");

    // A session reset mid-send clears the tab's attachments.
    resetChatTabState(state, { attachments: true });

    expect(staged.attachments).toEqual(["A.md"]);
    expect(staged.autoPath).toBe("Active.md");
  });
});
