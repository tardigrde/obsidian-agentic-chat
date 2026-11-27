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
  });
});
