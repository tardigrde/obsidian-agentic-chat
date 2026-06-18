import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";

/**
 * Model-backed e2e (NB6): exercises the paths the smoke spec deliberately avoids
 * because they need a real model turn — the approval gate/modal, a full
 * agent→tool→vault-write round trip, and the OpenRouter streaming path end to end.
 *
 * Gated on `OPENROUTER_API_KEY` (it spends real tokens). Run locally, never in CI:
 *
 *   OPENROUTER_API_KEY=sk-... npm run test:e2e -- --spec test/e2e/specs/guardrails.e2e.ts
 *
 * Without the key the whole suite `skip`s, so it stays inert in a key-less local
 * run. It is excluded from the tsc/eslint/vitest gates (see tsconfig.e2e.json) and
 * from CI, like the rest of the e2e suite. The remaining shipped guardrails
 * (attachment budget/restriction, read de-dup + size guardrail) are covered by unit
 * tests; they are hard to pin down through a model turn and would only add flake here.
 */

const NOTE_PATH = "E2E-NB6-Write.md";
const NOTE_BODY = "e2e write ok";

/** Open the chat view and wait for it to mount. */
async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $(".agentic-chat-view").waitForExist();
}

/** Type a prompt and submit it via the explicit composer control (same path as Enter). */
async function sendPrompt(prompt: string): Promise<void> {
  const input = await $(".agentic-chat-input");
  await input.click();
  await input.setValue(prompt);
  await $(".agentic-chat-send").click();
}

/**
 * Inject the OpenRouter key into the plugin's settings before the chat view mounts,
 * so the AgentService is constructed against a configured provider. Also pins Safe
 * mode + mutating=ask so a `write` routes through the approval modal. Returns true
 * if the plugin was found and configured.
 */
async function configureProvider(key: string): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }, apiKey) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) return false;
    const settings = plugin.settings as {
      openrouterApiKey: string;
      provider: string;
      mode: string;
      approval: { mutating: string };
    };
    settings.openrouterApiKey = apiKey;
    settings.provider = "openrouter";
    settings.mode = "safe";
    settings.approval.mutating = "ask";
    await plugin.saveSettings?.();
    return true;
  }, key);
}

describe("agentic-chat guardrails (model-backed)", function () {
  before(async function () {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) this.skip(); // No key → no tokens spent; suite stays inert.

    const configured = await configureProvider(key);
    if (!configured) throw new Error("agentic-chat plugin not found in the test vault");
    await openChat();
  });

  it("asks before a mutating write and commits once approved (approval modal)", async function () {
    // A fresh note name the agent is very likely to create via the write tool.
    await sendPrompt(
      `Create a brand new note at exactly the path "${NOTE_PATH}" whose entire body is the text: ${NOTE_BODY}`,
    );

    // Safe mode + mutating=ask → the gate surfaces the ApprovalModal before the write.
    const modal = await $(".agentic-chat-approval");
    await modal.waitForExist({ timeout: 90_000 });

    // Approve the write. The Setting buttons carry their label as text.
    const allow = await modal.$("button=Allow");
    await allow.waitForExist({ timeout: 5_000 });
    await allow.click();

    // The approved write should land in the vault (allow a generous model round trip).
    await browser.waitUntil(
      async () => {
        return await browser.executeObsidian(async ({ app }) => {
          return app.vault.getAbstractFileByPath(NOTE_PATH) != null;
        });
      },
      { timeout: 90_000, timeoutMsg: "approved write never appeared in the vault" },
    );

    const body = await browser.executeObsidian(async ({ app }) => {
      return await app.vault.read(app.vault.getAbstractFileByPath(NOTE_PATH)!);
    });
    expect(body).toContain(NOTE_BODY);
  });

  // Clean up the note we created so repeated local runs stay idempotent.
  after(async function () {
    if (!process.env.OPENROUTER_API_KEY) return;
    await browser.executeObsidian(async ({ app, obsidian }) => {
      const file = app.vault.getAbstractFileByPath(NOTE_PATH);
      if (file instanceof obsidian.TFile) await app.vault.trash(file, true);
    });
  });
});
