import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, Component } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ApprovalCard } from "../../src/ui/approval-card";
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

describe("TranscriptView approval records", () => {
  it("keeps the newest 200 settled approvals, not every one of a long session", () => {
    const view = new TranscriptView(document.createElement("div"), host());
    for (let index = 0; index < 250; index += 1) {
      view.recordApproval({ outcome: "allowed", toolCallId: `call-${index}`, el: document.createElement("div") } as unknown as ApprovalCard);
    }
    const outcomes = (view as unknown as { approvalOutcomes: Map<string, string> }).approvalOutcomes;
    expect(outcomes.size).toBe(200);
    expect(outcomes.has("call-0")).toBe(false);
    expect(outcomes.has("call-249")).toBe(true);
  });
});

describe("TranscriptView scroll scheduling", () => {
  function scrollable(): { view: TranscriptView; el: HTMLElement; frames: FrameRequestCallback[] } {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
    return { view: new TranscriptView(el, host()), el, frames };
  }

  it("coalesces calls in one frame into a single scroll, and a forced call wins", () => {
    const { view, el, frames } = scrollable();
    view.scrollToBottom();
    view.scrollToBottom();
    view.scrollToBottom({ force: true });
    expect(frames).toHaveLength(1);

    // The user scrolled up before the frame ran: only the forced request still scrolls.
    el.scrollTop = 0;
    view.markUserScrollIntent();
    view.updateScrollPinning();
    frames.shift()!(0);
    expect(el.scrollTop).toBe(1_000);

    // After the frame, a new request schedules a new frame.
    view.scrollToBottom({ force: true });
    expect(frames).toHaveLength(1);
    view.dispose();
  });

  it("a follow request does not scroll once the user unpinned before the frame", () => {
    const { view, el, frames } = scrollable();
    view.scrollToBottom();
    el.scrollTop = 0;
    view.markUserScrollIntent();
    view.updateScrollPinning();
    frames.shift()!(0);
    expect(el.scrollTop).toBe(0);
    view.dispose();
  });
});
