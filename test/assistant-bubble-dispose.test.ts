import { afterEach, describe, expect, it } from "vitest";
import { AssistantBubble } from "../src/ui/assistant-bubble";
import type { App, Component } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TranscriptView } from "../src/ui/transcript-view";
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
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
});

function useCountingObserver(): void {
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: CountingResizeObserver });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: () => 1 });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
}

function transcript(): TranscriptView {
  return new TranscriptView(fakeElement() as unknown as HTMLElement, {
    app: { workspace: {}, vault: {} } as unknown as App,
    component: {} as Component,
    renderEmptyState: () => {},
    beginEdit: () => {},
    retryLast: () => {},
    abortSubagentChild: () => {},
  });
}

describe("AssistantBubble observer lifecycle", () => {
  it("keeps the rail observer on a settled history bubble, so its toggles still resize the rail", () => {
    useCountingObserver();
    const bubble = new AssistantBubble(fakeElement() as unknown as HTMLElement);
    bubble.beginThinking();

    // TranscriptView disposes the previous live bubble when the next turn
    // starts, but that bubble stays on screen and interactive.
    bubble.dispose();
    expect(CountingResizeObserver.live.size).toBe(1);

    bubble.destroy();
    expect(CountingResizeObserver.live.size).toBe(0);
  });

  it("a transcript re-render leaves no observer from the cleared bubbles", () => {
    useCountingObserver();
    const view = transcript();
    view.beginAssistantMessage();
    view.beginAssistantMessage();
    expect(CountingResizeObserver.live.size).toBe(2);

    view.renderTranscript([] as AgentMessage[]);
    expect(CountingResizeObserver.live.size).toBe(0);
  });
});
