import { afterEach, describe, expect, it } from "vitest";
import { replayTextTurn } from "../../src/agent/replay-stream";
import { condenseSessions } from "../../scripts/chaos/miner-core";
import { mountChatView, settle, type MountedChatView } from "./support/mount-chat-view";

/**
 * U4 #17: `/doctor` in the real view. The panel opens with its status, then
 * the essentials and closed sections; the session file gets a small
 * `diagnostics` entry that the chaos miner condenses.
 */

let ui: MountedChatView;

afterEach(async () => {
  await ui?.close();
});

describe("/doctor (U4 #17)", () => {
  it("shows the status first, closed sections with counts, and saves a diagnostics entry for the miner", async () => {
    ui = await mountChatView({ turns: [replayTextTurn("hello")] });
    await ui.send("hi");
    await ui.idle();
    await ui.send("/doctor");
    await settle();

    for (let index = 0; index < 5 && !ui.$(".agentic-chat-doctor"); index += 1) await settle();
    const panel = ui.$(".agentic-chat-doctor");
    expect(panel).not.toBeNull();
    expect(panel?.querySelector(":scope > details > summary")?.textContent).toMatch(/^Doctor · (✅ All OK|⚠️ \d+ problems?|❌ \d+ problems?)$/);
    const sections = Array.from(panel?.querySelectorAll<HTMLDetailsElement>("details.agentic-chat-doctor-section") ?? []);
    expect(sections.map((section) => section.querySelector("summary")?.textContent?.split(" · ")[0])).toEqual([
      "Session and cost",
      "Plugins",
      "MCP",
      "Tools",
      "Debug",
    ]);
    // Folded by default: tool names and raw event names are inside, not on the page.
    expect(sections.every((section) => !section.open)).toBe(true);
    expect(panel?.querySelector(".agentic-chat-doctor-essentials")?.textContent).toContain("Cost");

    const { files } = await ui.adapter.list("sessions");
    const lines = (await ui.adapter.read(files[0])).trim().split("\n");
    const entries = lines.map((line) => JSON.parse(line) as { type?: string; summary?: { status?: string; counts?: { messages?: number } } });
    const diagnostics = entries.filter((entry) => entry.type === "diagnostics");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].summary?.counts?.messages).toBe(2);
    expect(condenseSessions([lines.join("\n")], 10_000)).toMatch(/<doctor> status=(ok|warn|error) problems=/);
  });
});
