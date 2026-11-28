import { afterEach, describe, expect, it } from "vitest";
import { replayTextTurn } from "../../src/agent/replay-stream";
import { mountChatView, settle, type MountedChatView } from "./support/mount-chat-view";

/** `/compact` keeps its command bubble after the transcript redraw. */

let ui: MountedChatView;

afterEach(async () => {
  await ui?.close();
});

describe("/compact", () => {
  it("keeps the command bubble after the transcript redraw", async () => {
    ui = await mountChatView({
      turns: [
        replayTextTurn("first answer"),
        replayTextTurn("second answer"),
        replayTextTurn("summary text"),
      ],
    });
    await ui.send("first question ".repeat(200));
    await ui.idle();
    await ui.send("second question ".repeat(200));
    await ui.idle();

    await ui.send("/compact");
    await settle(30);

    const bubbles = ui.$$(".agentic-chat-user").map((el) => el.textContent ?? "");
    expect(bubbles).toEqual(expect.arrayContaining([expect.stringContaining("/compact")]));
    // The rewrite landed, so the redraw that would have wiped the bubble ran.
    expect(ui.root.textContent).toContain("Compacted.");

    // The summary lives in the one Compact card below the kept turn and the
    // command, not in a block at the top of the transcript.
    const order = () =>
      ui.$$(".agentic-chat-user, .agentic-chat-info").map((el) =>
        el.classList.contains("agentic-chat-info") ? "card" : (el.textContent ?? "").trim().split(" ")[0],
      );
    expect(order()).toEqual(["second", "/compact", "card"]);
    const card = ui.$(".agentic-chat-info");
    expect(card?.textContent).toContain("Compacted.");
    expect(card?.textContent).toContain("Summarized earlier conversation");
    expect(card?.textContent).toContain("summary text");

    // A redraw (reopen, tab switch) keeps the card where the compaction ran,
    // before any later turn.
    const redraw = () =>
      (ui.view as unknown as { renderTranscript(messages: unknown[]): void }).renderTranscript([
        ...(ui.view as unknown as { service: { getMessages(): unknown[] } }).service.getMessages(),
        { role: "user", content: [{ type: "text", text: "third question" }], timestamp: Date.now() + 60_000 },
      ]);
    redraw();
    await settle();
    expect(order()).toEqual(["second", "card", "third"]);

    // A user message delivered outside the composer (a steer drained after the
    // rewrite) must still render; the redraw reset the pending local-render slot.
    const transcript = (
      ui.view as unknown as { transcript: { endUserMessage(message: unknown): void } }
    ).transcript;
    transcript.endUserMessage({
      role: "user",
      content: [{ type: "text", text: "delivered outside the composer" }],
      timestamp: Date.now(),
    });
    await settle();
    expect(ui.root.textContent).toContain("delivered outside the composer");
  });
});
