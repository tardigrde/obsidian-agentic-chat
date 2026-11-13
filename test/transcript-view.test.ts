import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, Component } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TranscriptView, type TranscriptViewHost } from "../src/ui/transcript-view";
import { fakeElement, type FakeElement } from "./helpers/fake-dom";

class NoopResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

function message(role: "user" | "assistant", text: string, extra: Record<string, unknown> = {}): AgentMessage {
  return { role, content: [{ type: "text", text }], timestamp: 1, ...extra } as unknown as AgentMessage;
}

function host(): TranscriptViewHost {
  return {
    app: { workspace: {}, vault: {} } as unknown as App,
    component: {} as Component,
    renderEmptyState: vi.fn(),
    beginEdit: vi.fn(),
    retryLast: vi.fn(),
    abortSubagentChild: vi.fn(),
  };
}

function snapshotLastAssistant(container: FakeElement): string {
  const assistant = container.children.at(-1);
  if (!assistant) throw new Error("assistant bubble missing");
  return assistant.snapshot();
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
});

describe("TranscriptView renderer agreement", () => {
  it("renders one message list identically through the live path and history replay", () => {
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: NoopResizeObserver });
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      },
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: () => {} });
    vi.spyOn(performance, "now").mockReturnValue(1_000);

    const answer = message("assistant", "The answer.", {
      errorMessage: "Weather warning.",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const messages = [message("user", "Hello"), answer];

    const liveEl = fakeElement();
    const live = new TranscriptView(liveEl as unknown as HTMLElement, host());
    live.renderOutgoingUserMessage("Hello", []);
    live.beginAssistantMessage();
    live.finalizeBubble(answer);

    const historyEl = fakeElement();
    const history = new TranscriptView(historyEl as unknown as HTMLElement, host());
    history.renderTranscript(messages);

    expect(snapshotLastAssistant(historyEl)).toBe(snapshotLastAssistant(liveEl));
  });
});
