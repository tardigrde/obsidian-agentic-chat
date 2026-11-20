import { afterEach, describe, expect, it, vi } from "vitest";
import { replayErrorTurn, replayTextTurn, replayToolCallTurn, type ReplayTurn } from "../../src/agent/replay-stream";
import { mountChatView, seedFile, settle, type MountedChatView } from "./support/mount-chat-view";

/**
 * The composer state machine, driven through the real ChatView and a real
 * AgentService with scripted model turns:
 *
 *   idle -> sending/streaming -> (approval pending) -> idle
 *                             -> stopped -> idle
 *                             -> error -> idle (Ask again)
 *
 * Each state is read from what the user sees: the send state, the Stop button,
 * the working indicator, the mode toggle, the inline approval card, and the
 * transcript.
 */

interface Gate {
  wait: () => Promise<void>;
  release: () => void;
}

/** A gate for `hold: true` turns: each held turn waits for one release. */
function gate(): Gate {
  const waiting: Array<() => void> = [];
  let released = 0;
  return {
    wait: () =>
      new Promise<void>((resolve) => {
        if (released > 0) {
          released -= 1;
          resolve();
        } else waiting.push(resolve);
      }),
    release: () => {
      const next = waiting.shift();
      if (next) next();
      else released += 1;
    },
  };
}

let ui: MountedChatView;

afterEach(async () => {
  await ui?.close();
});

const shown = (el: HTMLElement | null) => !!el && el.style.display !== "none";

function chrome() {
  return {
    send: ui.$<HTMLButtonElement>('[data-ac="send"]')?.getAttribute("data-ac-state") ?? "",
    stop: shown(ui.$(".agentic-chat-stop")),
    working: shown(ui.$(".agentic-chat-working")),
    modeDisabled: ui.$(".agentic-chat-mode-toggle")?.classList.contains("is-disabled") ?? false,
  };
}

const IDLE = { send: "send", stop: false, working: false, modeDisabled: false };
const STREAMING = { send: "queue", stop: true, working: true, modeDisabled: true };

async function mount(turns: ReplayTurn[], held?: Gate, settings = {}): Promise<void> {
  ui = await mountChatView({ turns, waitForRelease: held?.wait, settings });
}

describe("chat view state machine", () => {
  it("idle: empty state, Send, no Stop, no working indicator", async () => {
    await mount([]);
    expect(chrome()).toEqual(IDLE);
    expect(ui.$('[data-ac="empty"]')?.textContent).toContain("What should we work on?");
    expect(ui.$$('[data-ac="empty"] button')).toHaveLength(0);
  });

  it("idle -> streaming -> idle: one send renders the user turn, streams, and settles", async () => {
    const held = gate();
    await mount([replayTextTurn("the answer", { hold: true })], held);

    await ui.send("what is in my vault?");
    expect(chrome()).toEqual(STREAMING);
    expect(ui.$(".agentic-chat-empty")).toBeNull();
    expect(ui.$$(".agentic-chat-user").map((el) => el.textContent)).toEqual([expect.stringContaining("what is in my vault?")]);
    expect(ui.$<HTMLTextAreaElement>(".agentic-chat-input")?.value).toBe("");

    held.release();
    await ui.idle();
    expect(chrome()).toEqual(IDLE);
    expect(ui.$(".agentic-chat-assistant:last-child .agentic-chat-text")?.textContent).toContain("the answer");
    expect(ui.calls()).toBe(1);
  });

  it("send clears the composer and shrinks it back (the cleared value is re-measured)", async () => {
    await mount([replayTextTurn("ok")]);
    const input = ui.$<HTMLTextAreaElement>('[data-ac="composer-input"]')!;
    input.value = "a long prompt";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // As if the long draft had grown the box.
    input.style.setProperty("--ac-input-h", "200px");
    ui.$<HTMLButtonElement>('[data-ac="send"]')!.click();
    await settle();
    await ui.idle();
    expect(input.value).toBe("");
    expect(input.style.getPropertyValue("--ac-input-h")).not.toBe("200px");
  });

  it("a tap on the context ring opens the breakdown (touch has no hover); Esc closes it", async () => {
    await mount([replayTextTurn("the answer")]);
    await ui.send("hello");
    await ui.idle();
    const ring = ui.$<HTMLElement>('[data-ac="context"]');
    expect(ring?.style.display).not.toBe("none");
    expect(ring?.getAttribute("role")).toBe("button");
    expect(ring?.getAttribute("aria-expanded")).toBe("false");
    ring?.click();
    const panel = ui.$<HTMLElement>('[data-ac="context-breakdown"]');
    expect(panel?.style.display).not.toBe("none");
    expect(panel?.textContent).toBe(ring?.getAttribute("title"));
    expect(panel?.textContent).toMatch(/tokens \(estimated\)/);
    expect(ring?.getAttribute("aria-expanded")).toBe("true");
    ring?.ownerDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel?.style.display).toBe("none");
    expect(ring?.getAttribute("aria-expanded")).toBe("false");
    // Enter opens it from the keyboard too.
    ring?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(panel?.style.display).not.toBe("none");
  });

  it("streaming: 'Working…' is real text in the live region (screen readers hear it), gone when idle", async () => {
    const held = gate();
    await mount([replayTextTurn("the answer", { hold: true })], held);
    await ui.send("hi");
    const line = ui.$('.agentic-chat-status-line');
    expect(line?.getAttribute("aria-live")).toBe("polite");
    expect(line?.textContent).toContain("Working…");
    held.release();
    await ui.idle();
    expect(line?.textContent).not.toContain("Working…");
  });

  it("closing the view with the context breakdown open removes its document listeners", async () => {
    await mount([replayTextTurn("the answer")]);
    await ui.send("hello");
    await ui.idle();
    // The exact handlers the panel adds when it opens.
    const added = vi.spyOn(document, "addEventListener");
    ui.$<HTMLElement>('[data-ac="context"]')?.click();
    const handlers = added.mock.calls.map(([, handler]) => handler);
    added.mockRestore();
    expect(handlers.length).toBe(2);
    const removed = vi.spyOn(document, "removeEventListener");
    await ui.close();
    const gone = removed.mock.calls.map(([, handler]) => handler);
    removed.mockRestore();
    expect(handlers.every((handler) => gone.includes(handler))).toBe(true);
  });

  it("streaming: the Queue button holds the draft as a chip and sends it after the turn", async () => {
    const held = gate();
    await mount([replayTextTurn("first", { hold: true }), replayTextTurn("second")], held);
    await ui.send("first prompt");
    expect(chrome()).toEqual(STREAMING);

    await ui.queue("follow-up prompt");
    expect(chrome().send).toBe("update");
    expect(ui.$(".agentic-chat-chips")?.textContent).toContain("follow-up prompt");

    held.release();
    await ui.idle();
    await ui.idle();
    expect(ui.calls()).toBe(2);
    expect(ui.$$(".agentic-chat-user").map((el) => el.textContent?.trim())).toEqual([
      expect.stringContaining("first prompt"),
      expect.stringContaining("follow-up prompt"),
    ]);
    expect(chrome()).toEqual(IDLE);
  });

  it("streaming: Enter steers the running turn; the model sees the message on its next call", async () => {
    const held = gate();
    await mount([replayTextTurn("first", { hold: true }), replayTextTurn("steered answer")], held);
    await ui.send("start");
    await ui.send("also check the archive");
    expect(ui.$<HTMLTextAreaElement>(".agentic-chat-input")?.value).toBe("");
    held.release();
    await ui.idle();
    await ui.idle();
    expect(ui.calls()).toBe(2);
    expect(ui.root.textContent).toContain("also check the archive");
    expect(ui.$(".agentic-chat-assistant:last-child .agentic-chat-text")?.textContent).toContain("steered answer");
    expect(chrome()).toEqual(IDLE);
  });

  it("streaming -> stopped -> idle: Stop aborts the turn and keeps the queued draft unsent", async () => {
    const held = gate();
    await mount([replayTextTurn("never finishes", { hold: true })], held);
    await ui.send("long task");
    await ui.queue("draft while running");
    expect(chrome().send).toBe("update");

    ui.$<HTMLButtonElement>(".agentic-chat-stop")?.click();
    await ui.idle();
    expect(chrome()).toEqual(IDLE);
    expect(ui.calls()).toBe(1);
    // The held draft stays in the composer for a deliberate re-send.
    expect(ui.$<HTMLTextAreaElement>(".agentic-chat-input")?.value).toBe("draft while running");
    expect(ui.$(".agentic-chat-chips")?.textContent ?? "").not.toContain("draft while running");
  });

  it("streaming -> error -> idle: the error shows once in the bubble with Ask again", async () => {
    await mount([replayErrorTurn("provider exploded"), replayTextTurn("recovered")]);
    await ui.send("try it");
    await ui.idle();
    expect(chrome()).toEqual(IDLE);
    const errors = ui.$$(".agentic-chat-error");
    expect(errors).toHaveLength(1);
    expect(errors[0].textContent).toContain("provider exploded");

    const retry = ui.$<HTMLButtonElement>(".agentic-chat-error-retry") ?? ui.$<HTMLButtonElement>('[aria-label="Ask again"]');
    expect(retry).not.toBeNull();
    retry?.click();
    await ui.idle();
    expect(ui.calls()).toBe(2);
    expect(ui.$(".agentic-chat-assistant:last-child .agentic-chat-text")?.textContent).toContain("recovered");
  });

  it("streaming -> approval pending -> Allow -> idle: the inline card blocks the tool until allowed", async () => {
    await mount([
      replayToolCallTurn("call-1", "write", { path: "Notes/new.md", content: "hello" }),
      replayTextTurn("written"),
    ]);
    await ui.send("create a note");
    await settle();

    const card = ui.$('[data-ac="approval"]');
    expect(card).not.toBeNull();
    // In the transcript, below the turn's activity line, not in a modal.
    expect(ui.$(".modal-container")).toBeNull();
    expect(card?.closest('[data-ac="messages"]')).not.toBeNull();
    expect(card?.parentElement?.previousElementSibling?.getAttribute("data-ac")).toBe("activity");
    expect(ui.$('[data-ac="activity"]')?.getAttribute("data-ac-state")).toBe("needs-you");
    expect(ui.$('[data-ac="status"]')?.textContent).toBe("Waiting for your approval");
    expect(ui.$('[data-ac="tab"]')?.getAttribute("data-ac-state")).toBe("needs-you");
    expect(chrome()).toEqual(STREAMING);
    expect(ui.app.vault.contentOf("Notes/new.md")).toBeUndefined();

    // The keyboard path: Enter on the focused card allows it.
    expect(card?.ownerDocument.activeElement).toBe(card);
    card?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();
    // The last card is done: focus goes back to the composer, not to <body>.
    expect(card?.ownerDocument.activeElement).toBe(ui.$('[data-ac="composer-input"]'));
    await ui.idle();
    expect(ui.$('[data-ac="approval"]')?.getAttribute("data-ac-state")).toBe("allowed");
    expect(ui.$(".agentic-chat-approval-outcome")?.textContent).toBe("Allowed once");
    expect(ui.app.vault.contentOf("Notes/new.md")).toBe("hello");
    expect(chrome()).toEqual(IDLE);
    expect(ui.calls()).toBe(2);
  });

  it("an approval that settles after the user moved to another pane does not pull focus back to the composer", async () => {
    await mount([
      replayToolCallTurn("call-1", "write", { path: "Notes/new.md", content: "hello" }),
      replayTextTurn("written"),
    ]);
    await ui.send("create a note");
    await settle();

    const card = ui.$<HTMLElement>('[data-ac="approval"]');
    expect(card?.ownerDocument.activeElement).toBe(card);
    // Allow is clicked, then, while the settings update is in flight, the user
    // clicks blank text in a note in another pane: the chat view is no longer
    // the active view and focus sits on <body>.
    card?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    (ui.app.workspace as unknown as { activeView: unknown }).activeView = null;
    card?.blur();
    await settle();

    expect(card?.ownerDocument.activeElement).not.toBe(ui.$('[data-ac="composer-input"]'));
    await ui.idle();
    expect(ui.app.vault.contentOf("Notes/new.md")).toBe("hello");
  });

  it("two approvals at once in one tab (parallel MCP calls): the first to settle keeps the tab waiting for the second", async () => {
    const held = gate();
    await mount([replayTextTurn("working", { hold: true })], held);
    await ui.send("do two things");
    const view = ui.view as unknown as {
      activeTab: unknown;
      confirmToolCallForTab(tab: unknown, request: { toolName: string; label: string; args: unknown }): Promise<unknown>;
    };
    const tab = view.activeTab;
    const first = view.confirmToolCallForTab(tab, { toolName: "mcp__a__x", label: "Run x", args: {} });
    const second = view.confirmToolCallForTab(tab, { toolName: "mcp__b__y", label: "Run y", args: {} });
    await settle();
    expect(ui.$$('[data-ac="approval"]')).toHaveLength(2);

    ui.$$<HTMLButtonElement>('[data-ac="approval-allow"]')[0]?.click();
    await first;
    await settle();
    expect(ui.$('[data-ac="status"]')?.textContent).toBe("Waiting for your approval");
    expect(ui.$('[data-ac="tab"]')?.getAttribute("data-ac-state")).toBe("needs-you");
    expect(ui.$('[data-ac="activity"]')?.getAttribute("data-ac-state")).toBe("needs-you");

    ui.$$<HTMLButtonElement>('[data-ac="approval-allow"]')[0]?.click();
    await second;
    await settle();
    expect(ui.$('[data-ac="status"]')?.textContent).not.toBe("Waiting for your approval");
    expect(ui.$('[data-ac="tab"]')?.getAttribute("data-ac-state")).not.toBe("needs-you");
    held.release();
    await ui.idle();
  });

  it("a second approval does not steal focus from the first card's deny reason", async () => {
    const held = gate();
    await mount([replayTextTurn("working", { hold: true })], held);
    await ui.send("do two things");
    const view = ui.view as unknown as {
      activeTab: unknown;
      confirmToolCallForTab(tab: unknown, request: { toolName: string; label: string; args: unknown }): Promise<{ approved: boolean }>;
    };
    const tab = view.activeTab;
    const first = view.confirmToolCallForTab(tab, { toolName: "mcp__a__x", label: "Run x", args: {} });
    await settle();
    // The user starts the deny on card A and types a reason.
    ui.$<HTMLButtonElement>('[data-ac="approval-deny"]')?.click();
    await settle();
    const reason = ui.$<HTMLTextAreaElement>(".agentic-chat-deny-reason-input");
    expect(reason).not.toBeNull();
    expect(reason?.ownerDocument.activeElement).toBe(reason);
    const second = view.confirmToolCallForTab(tab, { toolName: "mcp__b__y", label: "Run y", args: {} });
    await settle();
    // Card B must not take focus: Enter still confirms the deny of card A.
    expect(reason?.ownerDocument.activeElement).toBe(reason);
    reason?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect((await first).approved).toBe(false);
    await settle();
    // Card A is done: focus moves on to card B, so Enter and Esc work there.
    const cardB = ui.$$<HTMLElement>('[data-ac="approval"]').find((el) => el.querySelector('[data-ac="approval-allow"]'));
    expect(reason?.ownerDocument.activeElement).toBe(cardB);
    ui.$$<HTMLButtonElement>('[data-ac="approval-allow"]').at(-1)?.click();
    await second;
    held.release();
    await ui.idle();
  });

  it("an approval that settles while its tab is in the background still shows its outcome on switch-back", async () => {
    const held = gate();
    await mount([replayTextTurn("working", { hold: true })], held);
    await ui.send("do it");
    const view = ui.view as unknown as {
      activeTab: unknown;
      confirmToolCallForTab(tab: unknown, request: { toolName: string; label: string; args: unknown }, signal?: AbortSignal): Promise<{ approved: boolean }>;
    };
    const tab1 = view.activeTab;
    // Open a second tab: tab 1 is now in the background.
    ui.$<HTMLButtonElement>('[data-ac="tab-add"]')?.click();
    await settle();
    const abort = new AbortController();
    const choice = view.confirmToolCallForTab(tab1, { toolName: "mcp__a__x", label: "Run x", args: {} }, abort.signal);
    await settle();
    abort.abort();
    expect((await choice).approved).toBe(false);
    // Back to tab 1: the user sees that an approval was asked and how it ended.
    ui.$$<HTMLElement>('[data-ac="tab"]')[0]?.click();
    await settle();
    const card = ui.$('[data-ac="approval"]');
    expect(card?.getAttribute("data-ac-state")).toBe("stopped");
    expect(card?.textContent).toContain("Stopped");
    held.release();
    await ui.idle();
  });

  it("allowing card A with Enter moves focus on to card B (parallel approvals)", async () => {
    const held = gate();
    await mount([replayTextTurn("working", { hold: true })], held);
    await ui.send("do two things");
    const view = ui.view as unknown as {
      activeTab: unknown;
      confirmToolCallForTab(tab: unknown, request: { toolName: string; label: string; args: unknown }): Promise<{ approved: boolean }>;
    };
    const tab = view.activeTab;
    const first = view.confirmToolCallForTab(tab, { toolName: "mcp__a__x", label: "Run x", args: {} });
    await settle();
    const second = view.confirmToolCallForTab(tab, { toolName: "mcp__b__y", label: "Run y", args: {} });
    await settle();
    const [cardA, cardB] = ui.$$<HTMLElement>('[data-ac="approval"]');
    expect(cardA?.ownerDocument.activeElement).toBe(cardA);
    cardA?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect((await first).approved).toBe(true);
    await settle();
    expect(cardA?.ownerDocument.activeElement).toBe(cardB);
    cardB?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect((await second).approved).toBe(true);
    held.release();
    await ui.idle();
  });

  it("approval pending -> Deny twice with a reason: the tool does not run and the reason reaches the model", async () => {
    await mount([
      replayToolCallTurn("call-1", "write", { path: "Notes/new.md", content: "hello" }),
      replayTextTurn("ok, not writing"),
    ]);
    await ui.send("create a note");
    await settle();

    const deny = () => ui.$<HTMLButtonElement>('[data-ac="approval-deny"]');
    deny()?.click();
    expect(deny()?.textContent).toBe("Confirm deny");
    expect(ui.$('[data-ac="approval"]')?.getAttribute("data-ac-state")).toBe("deny-armed");
    const reason = ui.$<HTMLTextAreaElement>(".agentic-chat-deny-reason-input");
    expect(reason).not.toBeNull();
    reason!.value = "wrong folder";
    deny()?.click();
    await ui.idle();

    expect(ui.$('[data-ac="approval"]')?.getAttribute("data-ac-state")).toBe("denied");
    expect(ui.app.vault.contentOf("Notes/new.md")).toBeUndefined();
    expect(ui.$(".agentic-chat-step")?.className).toContain("is-error");
    expect(ui.root.textContent).toContain("wrong folder");
    expect(chrome()).toEqual(IDLE);
  });

  it("approval pending -> Stop in the composer: the card resolves as stopped and nothing is written", async () => {
    await mount([replayToolCallTurn("call-1", "write", { path: "Notes/new.md", content: "hello" })]);
    await ui.send("create a note");
    await settle();
    ui.$<HTMLButtonElement>('[data-ac="stop"]')?.click();
    await ui.idle();
    expect(ui.$('[data-ac="approval"]')?.getAttribute("data-ac-state")).toBe("stopped");
    expect(ui.app.vault.contentOf("Notes/new.md")).toBeUndefined();
    expect(chrome()).toEqual(IDLE);
    expect(ui.calls()).toBe(1);
  });

  it("approval pending -> new session: the choice settles as stopped (no hang, nothing written)", async () => {
    await mount([replayToolCallTurn("call-1", "write", { path: "Notes/new.md", content: "hello" })]);
    await ui.send("create a note");
    await settle();
    const card = ui.$('[data-ac="approval"]');
    expect(card?.getAttribute("data-ac-state")).not.toBe("stopped");
    // The swap aborts the turn before the transcript re-renders: the card must settle.
    await (ui.view as unknown as { newSession(): Promise<void> }).newSession();
    await ui.idle();
    expect(card?.getAttribute("data-ac-state")).toBe("stopped");
    expect(ui.app.vault.contentOf("Notes/new.md")).toBeUndefined();
    expect(chrome()).toEqual(IDLE);
  });

  it("YOLO mode skips the approval card", async () => {
    await mount(
      [replayToolCallTurn("call-1", "write", { path: "Notes/yolo.md", content: "fast" }), replayTextTurn("done")],
      undefined,
      { mode: "yolo" },
    );
    expect(ui.$(".agentic-chat-mode-toggle")?.getAttribute("aria-checked")).toBe("true");
    await ui.send("write it");
    await ui.idle();
    expect(ui.$('[data-ac="approval"]')).toBeNull();
    expect(ui.app.vault.contentOf("Notes/yolo.md")).toBe("fast");
  });

  it("the mode toggle flips Safe <-> YOLO when idle and refuses while streaming", async () => {
    const held = gate();
    await mount([replayTextTurn("slow", { hold: true })], held);
    const toggle = ui.$(".agentic-chat-mode-toggle");
    toggle?.click();
    await settle();
    expect(ui.settings.mode).toBe("yolo");
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    toggle?.click();
    await settle();
    expect(ui.settings.mode).toBe("safe");

    await ui.send("long");
    toggle?.click();
    await settle();
    expect(ui.settings.mode).toBe("safe");
    held.release();
    await ui.idle();
  });

  it("an attached note shows as a chip, goes out with the prompt, and stays for the next turn", async () => {
    await mount([replayTextTurn("read it")]);
    await seedFile(ui.app, "Notes/Plan.md", "the plan");
    const file = ui.app.vault.getFileByPath("Notes/Plan.md");
    ui.view.attachVaultEntryFromMenu(file!);
    expect(ui.$(".agentic-chat-chips")?.textContent).toContain("Plan");
    await ui.send("summarize the attached note");
    await ui.idle();
    expect(ui.$(".agentic-chat-user")?.textContent).toContain("Plan");
    // Context is sticky: it stays attached until removed or the session changes.
    expect(ui.$(".agentic-chat-chips")?.textContent).toContain("Plan");
  });
});
