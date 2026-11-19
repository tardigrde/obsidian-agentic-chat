import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { configureScriptedPlugin, openChat, submitComposer, waitForIdle, waitForTranscript } from "../support/chat";
import { clearScriptedTurns, installScriptedTurns, textTurn } from "../support/scripted-stream";

/**
 * A typo such as `/sesions` is not a command or a skill. It shows a hint and
 * never reaches the model. Text that only starts with a slash, such as a path,
 * still goes to the model.
 */
describe("unknown slash command", function () {
  before(async function () {
    // One scripted reply. Turns are a queue, not matched by text: if the typo
    // reached the model, it would take this reply first.
    await installScriptedTurns([textTurn("path prompt", "The model got the path.")]);
    await configureScriptedPlugin("allow");
    await openChat();
  });

  after(async function () {
    await clearScriptedTurns();
  });

  it("shows a hint for an unknown command and does not send it to the model", async function () {
    await submitComposer("/sesions clear");
    await waitForTranscript("Unknown command");
    await expect($('[data-ac="messages"]')).toHaveText(/is not a command or a skill/);
    await expect($('[data-ac="messages"]')).not.toHaveText(/The model got the path/);
    if (process.env.AGENTIC_CHAT_SCREENSHOT_DIR) {
      await browser.saveScreenshot(`${process.env.AGENTIC_CHAT_SCREENSHOT_DIR}/unknown-command.png`);
    }

    await submitComposer("/home/me/notes.md what is in it?");
    await waitForTranscript("The model got the path.");
    await waitForIdle();
  });
});
