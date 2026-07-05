import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  SessionActivationCoordinator,
  type SessionUiResetOptions,
} from "../src/ui/session-activation-coordinator";

function assistantMessage(content: string): AgentMessage {
  return { role: "assistant", content } as unknown as AgentMessage;
}

function makeCoordinator(messages: AgentMessage[] = [assistantMessage("loaded")]): {
  coordinator: SessionActivationCoordinator;
  events: string[];
  resets: SessionUiResetOptions[];
  rendered: AgentMessage[][];
} {
  const events: string[] = [];
  const resets: SessionUiResetOptions[] = [];
  const rendered: AgentMessage[][] = [];
  return {
    events,
    resets,
    rendered,
    coordinator: new SessionActivationCoordinator({
      setMuteNotifications: (muted) => events.push(`mute:${muted}`),
      resetUsageNotifications: (muteExisting = false) => events.push(`usage:${muteExisting}`),
      resetUiState: (options) => {
        events.push("reset");
        resets.push(options);
      },
      messages: () => messages,
      renderTranscript: (next) => {
        events.push(`render:${next.length}`);
        rendered.push(next);
      },
      syncActiveNote: () => events.push("active-note"),
      syncTabStrip: () => events.push("tabs"),
      syncChrome: () => events.push("chrome"),
      flushQueuedPromptIfReady: () => {
        events.push("flush");
      },
    }),
  };
}

describe("SessionActivationCoordinator", () => {
  it("renders active tabs under notification mute and flushes queued prompts", () => {
    const ctx = makeCoordinator();

    ctx.coordinator.renderActiveTab();

    expect(ctx.events).toEqual([
      "reset",
      "mute:true",
      "active-note",
      "render:1",
      "chrome",
      "flush",
      "mute:false",
      "tabs",
    ]);
    expect(ctx.resets).toEqual([{ editing: true, bubble: true }]);
  });

  it("starts a clean new conversation even when the service operation throws", async () => {
    const ctx = makeCoordinator();

    await expect(
      ctx.coordinator.startNewConversation(async () => {
        throw new Error("swap failed");
      }),
    ).rejects.toThrow("swap failed");

    expect(ctx.events).toEqual([
      "mute:true",
      "mute:false",
      "reset",
      "active-note",
      "render:0",
      "chrome",
      "tabs",
    ]);
    expect(ctx.resets[0]).toMatchObject({
      attachments: true,
      activeNoteSuppression: true,
      lastSent: true,
      relevantNotes: true,
      activeNoteCache: true,
      history: true,
      editing: true,
      bubble: true,
    });
  });

  it("loads existing conversations with muted existing-usage thresholds", async () => {
    const ctx = makeCoordinator();

    await ctx.coordinator.loadConversation(async () => {
      ctx.events.push("load");
    });

    expect(ctx.events).toEqual([
      "mute:true",
      "load",
      "usage:true",
      "mute:false",
      "reset",
      "render:1",
      "chrome",
      "tabs",
    ]);
    expect(ctx.resets).toEqual([{ lastSent: true, activeNoteCache: true, editing: true, bubble: true }]);
  });

  it("continues project sessions with attachment and active-note reset", async () => {
    const ctx = makeCoordinator();

    await ctx.coordinator.continueProjectSession(async () => {
      ctx.events.push("continue");
    });

    expect(ctx.events).toEqual([
      "reset",
      "mute:true",
      "continue",
      "usage:true",
      "mute:false",
      "render:1",
      "tabs",
      "active-note",
      "chrome",
    ]);
    expect(ctx.resets).toEqual([
      { attachments: true, activeNoteSuppression: true, activeNoteCache: true, lastSent: true, editing: true },
    ]);
  });

  it("resets clean UI state after clearing sessions", () => {
    const ctx = makeCoordinator([]);

    ctx.coordinator.afterSessionsCleared();

    expect(ctx.events).toEqual(["reset", "usage:false", "render:0", "active-note", "tabs", "chrome"]);
    expect(ctx.resets[0]).toMatchObject({
      attachments: true,
      activeNoteSuppression: true,
      lastSent: true,
      relevantNotes: true,
      activeNoteCache: true,
      history: true,
      editing: true,
      bubble: true,
    });
  });

  it("initializes a fresh tab and renders it after reporting startup errors", async () => {
    const ctx = makeCoordinator();
    const errors: string[] = [];

    await ctx.coordinator.initializeFreshTab(
      async () => {
        throw new Error("new tab failed");
      },
      (error) => errors.push(error instanceof Error ? error.message : String(error)),
    );

    expect(errors).toEqual(["new tab failed"]);
    expect(ctx.events).toEqual([
      "mute:true",
      "mute:false",
      "reset",
      "mute:true",
      "active-note",
      "render:1",
      "chrome",
      "flush",
      "mute:false",
      "tabs",
    ]);
  });

  it("initializes the active session with existing notification baselines", async () => {
    const ctx = makeCoordinator();
    const errors: string[] = [];

    await ctx.coordinator.initializeActiveSession(
      async () => {
        ctx.events.push("initialize");
      },
      (error) => errors.push(String(error)),
    );

    expect(errors).toEqual([]);
    expect(ctx.events).toEqual([
      "mute:true",
      "initialize",
      "usage:true",
      "mute:false",
      "active-note",
      "render:1",
      "chrome",
      "tabs",
    ]);
  });
});
