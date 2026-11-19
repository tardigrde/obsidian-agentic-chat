import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantBubble } from "../../src/ui/assistant-bubble";

/** The reasoning pill's lifecycle: none -> thinking -> thought, or dropped on an empty error. */

class NoopResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function bubble(): { bubble: AssistantBubble; parent: HTMLElement } {
  const parent = document.createElement("div");
  return { bubble: new AssistantBubble(parent), parent };
}

const pills = (parent: HTMLElement) => parent.querySelectorAll(".agentic-chat-reasoning");

describe("AssistantBubble reasoning pill phases", () => {
  it("walks none -> thinking -> thought, and a late begin does not mount a second pill", () => {
    const { bubble: b, parent } = bubble();
    expect(b.reasoningPhase).toBe("none");
    b.beginThinking();
    expect(b.reasoningPhase).toBe("thinking");
    b.appendText("answer");
    expect(b.reasoningPhase).toBe("thought");
    b.beginThinking();
    b.finalizeWithoutText();
    expect(b.reasoningPhase).toBe("thought");
    expect(pills(parent)).toHaveLength(1);
    b.dispose();
  });

  it("a first reasoning delta mounts the pill without beginThinking", () => {
    const { bubble: b, parent } = bubble();
    b.appendReasoning("hmm");
    expect(b.reasoningPhase).toBe("thinking");
    expect(pills(parent)).toHaveLength(1);
    b.dispose();
  });

  it("an error drops an empty pill for good: late deltas and begin cannot remount it", () => {
    const { bubble: b, parent } = bubble();
    b.beginThinking();
    b.showError("boom");
    expect(b.reasoningPhase).toBe("dropped");
    expect(pills(parent)).toHaveLength(0);

    b.appendReasoning("late");
    b.beginThinking();
    b.appendText("late text");
    b.finalizeWithoutText();
    expect(b.reasoningPhase).toBe("dropped");
    expect(pills(parent)).toHaveLength(0);
  });

  it("an error keeps a pill that holds reasoning, settled as thought", () => {
    const { bubble: b, parent } = bubble();
    b.appendReasoning("real trace");
    b.showError("boom");
    expect(b.reasoningPhase).toBe("thinking");
    b.finalizeWithoutText();
    expect(b.reasoningPhase).toBe("thought");
    expect(parent.querySelector(".agentic-chat-reasoning.is-done")).not.toBeNull();
    b.dispose();
  });
});
