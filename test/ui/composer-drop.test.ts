import { afterEach, describe, expect, it } from "vitest";
import { mountChatView, seedFile, settle, type MountedChatView } from "./support/mount-chat-view";
import { shownNotices } from "./support/obsidian-dom";
import { clearPricingCacheForTests, seedPricingCacheForTests } from "../../src/llm/pricing-cache";

/** U3 #8: dropping an image on a text-only model. */

let ui: MountedChatView;

afterEach(async () => {
  await ui?.close();
  clearPricingCacheForTests();
});

describe("composer drop", () => {
  it("U3 #8: repeated drops of an image on a text-only model show one notice, not one per drop", async () => {
    // Only a model the catalog marks text-only refuses images (U4 #6).
    const base = { n: "m", c: 1000, m: 100, pi: 0, po: 0, pr: 0, pw: 0, t: 1 as const, re: 0 as const, tlm: null, im: 0 as const };
    seedPricingCacheForTests({ "deepseek/deepseek-v4.1-flash": { id: "deepseek/deepseek-v4.1-flash", ...base } });
    ui = await mountChatView();
    const image = await seedFile(ui.app, "700 Media/adulthood.png", "png");
    (ui.app.app as unknown as { dragManager: unknown }).dragManager = { draggable: { file: image } };
    const composer = ui.$('[data-ac="composer"]');
    shownNotices.length = 0;

    for (let index = 0; index < 16; index += 1) {
      composer?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
    }
    await settle();

    expect(shownNotices.filter((message) => /can't read images/.test(message))).toHaveLength(1);
    expect(ui.$$(".agentic-chat-chip")).toHaveLength(0);
  });
});
