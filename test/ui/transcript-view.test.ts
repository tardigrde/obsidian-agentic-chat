import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, Component } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TranscriptView, type TranscriptViewHost } from "../../src/ui/transcript-view";

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

function snapshotLastAssistant(container: HTMLElement): string {
  const assistant = container.lastElementChild;
  if (!assistant) throw new Error("assistant bubble missing");
  return assistant.outerHTML;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TranscriptView renderer agreement", () => {
  it("renders one message list identically through the live path and history replay", () => {
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
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

    const liveEl = document.createElement("div");
    const live = new TranscriptView(liveEl, host());
    live.renderOutgoingUserMessage("Hello", []);
    live.beginAssistantMessage();
    live.finalizeBubble(answer);

    const historyEl = document.createElement("div");
    const history = new TranscriptView(historyEl, host());
    history.renderTranscript(messages);

    expect(snapshotLastAssistant(historyEl)).toBe(snapshotLastAssistant(liveEl));
  });
});
