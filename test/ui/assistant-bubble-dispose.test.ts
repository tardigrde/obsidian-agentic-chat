import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantBubble } from "../../src/ui/assistant-bubble";
import type { App, Component } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TranscriptView } from "../../src/ui/transcript-view";

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
  vi.unstubAllGlobals();
});

function useCountingObserver(): void {
  vi.stubGlobal("ResizeObserver", CountingResizeObserver);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
}

function transcript(): TranscriptView {
  return new TranscriptView(document.createElement("div"), {
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
    const bubble = new AssistantBubble(document.createElement("div"));
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
