import { afterEach, describe, expect, it } from "vitest";
import { replayTextTurn, replayToolCallTurn } from "../../src/agent/replay-stream";
import { mountChatView, settle, type MountedChatView } from "./support/mount-chat-view";

/** The inline ask_user card, driven by a real ask_user tool call. */

let ui: MountedChatView;

afterEach(async () => {
  await ui?.close();
});

async function askFolder(): Promise<void> {
  ui = await mountChatView({
    turns: [
      replayToolCallTurn("call-1", "ask_user", { question: "Which folder should I use?", choices: ["Notes", "Archive"] }),
      replayTextTurn("Using the folder you chose."),
    ],
  });
  await ui.send("file this note");
  await settle();
}

describe("ask_user card", () => {
  it("shows the question and choices, and a choice answers and removes the card", async () => {
    await askFolder();
    expect(ui.$(".agentic-chat-ask-question")?.textContent).toBe("Which folder should I use?");
    expect(ui.$$(".agentic-chat-ask-choice").map((el) => el.textContent)).toEqual(["Notes", "Archive"]);

    ui.$$<HTMLButtonElement>(".agentic-chat-ask-choice")[1].click();
    await ui.idle();
    expect(ui.$(".agentic-chat-ask-user")).toBeNull();
    expect(ui.calls()).toBe(2);
    expect(ui.$(".agentic-chat-assistant:last-child .agentic-chat-text")?.textContent).toContain("Using the folder you chose.");
  });

  it("Ctrl+Enter sends a typed answer; an empty answer is not sent", async () => {
    await askFolder();
    const input = ui.$<HTMLTextAreaElement>(".agentic-chat-ask-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, cancelable: true }));
    await settle();
    expect(ui.$(".agentic-chat-ask-user")).not.toBeNull();

    input.value = "Projects/2026";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, cancelable: true }));
    await ui.idle();
    expect(ui.$(".agentic-chat-ask-user")).toBeNull();
    expect(ui.calls()).toBe(2);
  });

  it("Stop cancels the question and the turn", async () => {
    await askFolder();
    ui.$<HTMLButtonElement>(".agentic-chat-stop")?.click();
    await ui.idle();
    expect(ui.$(".agentic-chat-ask-state")?.textContent).toBe("Question cancelled.");
    expect(ui.$<HTMLTextAreaElement>(".agentic-chat-ask-input")?.disabled).toBe(true);
    // pi may open one more stream with the aborted signal; it ends at once with no text.
    expect(ui.root.textContent).not.toContain("Using the folder you chose.");
    expect(ui.$<HTMLButtonElement>('[data-ac="send"]')?.getAttribute("data-ac-state")).toBe("send");
  });
});
