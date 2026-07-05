import { describe, expect, it } from "vitest";
import { freshChatTabState } from "../src/ui/chat-tab-state";

describe("freshChatTabState", () => {
  it("creates the default per-tab UI state", () => {
    expect(freshChatTabState()).toMatchObject({
      attachments: [],
      activeNoteSuppressed: false,
      draft: "",
      queuedPromptArmed: false,
      sentHistory: [],
      notifiedCost: false,
      lastCompactionCount: 0,
      lastSentPrompt: null,
      lastSentDisplay: null,
      relevantPinnedPaths: [],
      relevantExcludedPaths: [],
    });
  });

  it("does not share mutable collections across tabs", () => {
    const first = freshChatTabState();
    const second = freshChatTabState();

    first.attachments.push("A.md");
    first.sentHistory.push("hello");
    first.notifiedContext.add(0.75);
    first.relevantPinnedPaths.push("Pinned.md");
    first.relevantExcludedPaths.push("Excluded.md");

    expect(second.attachments).toEqual([]);
    expect(second.sentHistory).toEqual([]);
    expect([...second.notifiedContext]).toEqual([]);
    expect(second.relevantPinnedPaths).toEqual([]);
    expect(second.relevantExcludedPaths).toEqual([]);
  });
});
