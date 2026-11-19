import { afterEach, describe, expect, it } from "vitest";
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
 * Each state is read from what the user sees: the Send label, the Stop button,
 * the working indicator, the mode toggle, the approval modal, and the transcript.
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

  it("streaming -> approval pending -> Allow -> idle: the modal blocks the tool until allowed", async () => {
    await mount([
      replayToolCallTurn("call-1", "write", { path: "Notes/new.md", content: "hello" }),
      replayTextTurn("written"),
    ]);
    await ui.send("create a note");
    await settle();

    const modal = ui.$(".modal-container .agentic-chat-approval");
    expect(modal).not.toBeNull();
    expect(ui.$(".modal-title")?.textContent).toMatch(/write|Notes\/new\.md/i);
    expect(chrome()).toEqual(STREAMING);
    expect(ui.app.vault.contentOf("Notes/new.md")).toBeUndefined();

    const allow = ui.$$<HTMLButtonElement>(".modal-container button").find((button) => button.textContent === "Allow");
    allow?.click();
    await ui.idle();
    expect(ui.$(".modal-container")).toBeNull();
    expect(ui.app.vault.contentOf("Notes/new.md")).toBe("hello");
    expect(chrome()).toEqual(IDLE);
    expect(ui.calls()).toBe(2);
  });

  it("approval pending -> Deny twice with a reason: the tool does not run and the reason reaches the model", async () => {
    await mount([
      replayToolCallTurn("call-1", "write", { path: "Notes/new.md", content: "hello" }),
      replayTextTurn("ok, not writing"),
    ]);
    await ui.send("create a note");
    await settle();

    const deny = () => ui.$$<HTMLButtonElement>(".modal-container button").find((button) => /Deny/.test(button.textContent ?? ""));
    deny()?.click();
    expect(deny()?.textContent).toBe("Confirm Deny");
    expect(ui.$(".modal-title")?.textContent).toMatch(/deny/i);
    const reason = ui.$<HTMLTextAreaElement>(".agentic-chat-deny-reason-input");
    expect(reason).not.toBeNull();
    reason!.value = "wrong folder";
    deny()?.click();
    await ui.idle();

    expect(ui.$(".modal-container")).toBeNull();
    expect(ui.app.vault.contentOf("Notes/new.md")).toBeUndefined();
    expect(ui.$(".agentic-chat-step")?.className).toContain("is-error");
    expect(ui.root.textContent).toContain("wrong folder");
    expect(chrome()).toEqual(IDLE);
  });

  it("approval pending -> Stop turn in the modal: the turn stops and nothing is written", async () => {
    await mount([replayToolCallTurn("call-1", "write", { path: "Notes/new.md", content: "hello" })]);
    await ui.send("create a note");
    await settle();
    ui.$$<HTMLButtonElement>(".modal-container button").find((button) => button.textContent === "Stop turn")?.click();
    await ui.idle();
    expect(ui.$(".modal-container")).toBeNull();
    expect(ui.app.vault.contentOf("Notes/new.md")).toBeUndefined();
    expect(chrome()).toEqual(IDLE);
    expect(ui.calls()).toBe(1);
  });

  it("YOLO mode skips the approval modal", async () => {
    await mount(
      [replayToolCallTurn("call-1", "write", { path: "Notes/yolo.md", content: "fast" }), replayTextTurn("done")],
      undefined,
      { mode: "yolo" },
    );
    expect(ui.$(".agentic-chat-mode-toggle")?.getAttribute("aria-checked")).toBe("true");
    await ui.send("write it");
    await ui.idle();
    expect(ui.$(".modal-container")).toBeNull();
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
