import { readFileSync } from "node:fs";
import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { expectNoHorizontalOverflow } from "../../support/layout";
import { mark, writeMetrics } from "../../support/record";
import {
  configurePlugin,
  noteExists,
  openChat,
  readNote,
  renderedAssistantText,
  sendPrompt,
  trashNotes,
  waitForNewAssistantText,
} from "../support/probe-helpers";

const NOTE = "Probe-Live-Chat.md";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openrouter/auto";

function readApiKey(): string | undefined {
  const inline = process.env.AGENTIC_CHAT_API_KEY?.trim();
  if (inline) return inline;
  const file = process.env.AGENTIC_CHAT_API_KEY_FILE?.trim();
  if (!file) return undefined;
  const fromFile = readFileSync(file, "utf8").trim();
  return fromFile || undefined;
}

/**
 * Live probe: one real model answer and one real tool call, recorded end to end.
 * Requires --live; the probe runner refuses to start otherwise.
 */
describe("probe: live chat", function () {
  this.timeout(240_000);
  let model = DEFAULT_MODEL;

  before(async function () {
    if (process.env.AGENTIC_CHAT_PROBE_LIVE !== "1") this.skip();
    const apiKey = readApiKey();
    if (!apiKey) this.skip();

    const baseUrl = process.env.AGENTIC_CHAT_BASE_URL?.trim() || DEFAULT_BASE_URL;
    model = process.env.AGENTIC_CHAT_MODEL?.trim() || DEFAULT_MODEL;

    await trashNotes([NOTE]);
    await configurePlugin({
      provider: "openai-compatible",
      openaiCompatibleApiKey: apiKey,
      openaiCompatibleBaseUrl: baseUrl,
      openaiCompatibleModel: model,
      requestTimeoutMs: 120_000,
      maxNetworkRetries: 0,
      mode: "safe",
      approval: { mutating: "ask", perTool: {}, workingDirs: [] },
    });
    await openChat();
  });

  after(async function () {
    await trashNotes([NOTE]);
  });

  it("records a real answer and a real tool call", async function () {
    await mark("chat open");

    const beforeAnswer = await renderedAssistantText();
    await sendPrompt("In one short sentence, describe what this Obsidian plugin does.");
    const answer = await waitForNewAssistantText(beforeAnswer);
    expect(answer.trim().length).toBeGreaterThan(10);
    await mark("live assistant answer");
    await writeMetrics({ mode: "live", model, answerChars: answer.length });

    await sendPrompt(`Create a note named ${NOTE} containing exactly: hello from probe`);

    const approval = await $(".agentic-chat-approval");
    await approval.waitForExist({ timeout: 120_000 });
    await browser.pause(500);
    await mark("approval prompt visible");
    await browser.pause(1_500);

    const allow = await approval.$("button=Allow");
    await allow.waitForExist({ timeout: 5_000 });
    await allow.click();
    await browser.pause(800);
    await mark("approval granted");

    await browser.waitUntil(async () => await noteExists(NOTE), {
      timeout: 120_000,
      timeoutMsg: "the live tool call never created the note",
    });
    expect(await readNote(NOTE)).toContain("hello from probe");
    await browser.pause(800);
    await mark("live tool call wrote the note");

    await expectNoHorizontalOverflow(".agentic-chat-view");
    await writeMetrics({ note: NOTE, noteContent: await readNote(NOTE), mode: "live", model });

    // Hold the final state so the recording does not end on a closing window.
    await browser.pause(1_500);
  });
});
