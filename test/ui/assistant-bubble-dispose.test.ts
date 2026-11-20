import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, Component } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { TranscriptView } from "../../src/ui/transcript-view";

/**
 * A live turn's activity line runs a one-second clock. No clock may outlive
 * its turn: the turn ending, a transcript re-render (tab switch, session load),
 * and the view closing all stop it.
 */

const live = new Set<number>();
let nextId = 1;

function useCountingTimers(): void {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(window, "setInterval").mockImplementation((() => {
    const id = nextId++;
    live.add(id);
    return id;
  }) as unknown as typeof window.setInterval);
  vi.spyOn(window, "clearInterval").mockImplementation(((id: number) => {
    live.delete(id);
  }) as unknown as typeof window.clearInterval);
}

afterEach(() => {
  live.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

describe("activity line clock lifecycle", () => {
  it("a live turn starts one clock and the turn ending stops it", () => {
    useCountingTimers();
    const view = transcript();
    view.beginRun();
    view.beginAssistantMessage();
    view.beginAssistantMessage();
    expect(live.size).toBe(1);
    view.endRun();
    expect(live.size).toBe(0);
  });

  it("a transcript re-render leaves no clock from the cleared turn", () => {
    useCountingTimers();
    const view = transcript();
    view.beginRun();
    expect(live.size).toBe(1);
    view.renderTranscript([] as AgentMessage[]);
    expect(live.size).toBe(0);
  });

  it("closing the view stops a running turn's clock", () => {
    useCountingTimers();
    const view = transcript();
    view.beginRun();
    view.dispose();
    expect(live.size).toBe(0);
  });
});
