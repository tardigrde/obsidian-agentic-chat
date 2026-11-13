import { afterEach, describe, expect, it } from "vitest";
import { AssistantBubble } from "../src/ui/assistant-bubble";
import { fakeElement } from "./helpers/fake-dom";

class CountingResizeObserver {
  static live = new Set<CountingResizeObserver>();

  constructor(_callback: ResizeObserverCallback) {}

  observe(): void {
    CountingResizeObserver.live.add(this);
  }

  unobserve(): void {
    CountingResizeObserver.live.delete(this);
  }

  disconnect(): void {
    CountingResizeObserver.live.delete(this);
  }
}

afterEach(() => {
  CountingResizeObserver.live.clear();
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

describe("AssistantBubble dispose", () => {
  it("disconnects the timeline observer so a re-render leaves no live observer", () => {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: CountingResizeObserver,
    });

    const first = new AssistantBubble(fakeElement() as unknown as HTMLElement);
    first.beginThinking();
    expect(CountingResizeObserver.live.size).toBe(1);

    // TranscriptView.beginRun/beginAssistantMessage disposes the old bubble
    // before mounting the next one.
    first.dispose();
    expect(CountingResizeObserver.live.size).toBe(0);

    const second = new AssistantBubble(fakeElement() as unknown as HTMLElement);
    second.beginThinking();
    expect(CountingResizeObserver.live.size).toBe(1);
    second.dispose();
    expect(CountingResizeObserver.live.size).toBe(0);
  });
});
