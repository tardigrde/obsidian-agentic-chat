import { $, browser, expect } from "@wdio/globals";
import { waitForComposerReady } from "./layout";

/**
 * Shared chat-view actions for e2e specs. Every send waits until the composer
 * can be hit first: a missed send shifts every later scripted turn by one, so
 * one flaky click used to fail a whole spec (#393 T12).
 */

export const VIEW_TYPE_AGENT_CHAT = "agentic-chat-chat-view";

export async function openChat(): Promise<void> {
  await browser.executeObsidianCommand("agentic-chat:open-chat");
  await $('[data-ac="view"]').waitForExist();
  await waitForComposerReady();
}

/** Type into the composer and press its send control, like a user. */
export async function sendPrompt(prompt: string): Promise<void> {
  await waitForComposerReady();
  const input = await $('[data-ac="composer-input"]');
  await input.click();
  await input.setValue(prompt);
  await $('[data-ac="send"]').click();
}

/** Set the composer value and click send in one page call. Same submit route
 * as Enter, without version-specific WebDriver key synthesis. */
export async function submitComposer(value: string): Promise<void> {
  await waitForComposerReady();
  await browser.execute((text) => {
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-ac="composer-input"]');
    const send = document.querySelector<HTMLButtonElement>('[data-ac="send"]');
    if (!textarea || !send) throw new Error("agentic-chat composer is not mounted");
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    send.click();
  }, value);
}

export async function transcriptText(): Promise<string> {
  return await browser.execute(() => document.querySelector<HTMLElement>('[data-ac="messages"]')?.innerText ?? "");
}

export async function waitForTranscript(text: string, timeout = 10_000): Promise<void> {
  await browser.waitUntil(async () => (await transcriptText()).includes(text), {
    timeout,
    timeoutMsg: `transcript never showed ${JSON.stringify(text)}`,
  });
}

/** Text of the newest info block (slash-command output). */
export async function latestInfoText(): Promise<string> {
  await $('[data-ac="info"], [data-ac="error"]').waitForExist();
  return await browser.execute(() => {
    const infos = Array.from(document.querySelectorAll<HTMLElement>('[data-ac="info"], [data-ac="error"]'));
    return infos.at(-1)?.innerText ?? "";
  });
}

/**
 * Wait until no turn is running. Stop and Queue share one round button (U4):
 * Stop hides while the user types, so idle is "the button says Send".
 */
export async function waitForIdle(timeout = 10_000): Promise<void> {
  // No chat view open is idle too (a spec may have closed the pane).
  const idle = async () =>
    await browser.execute(() => {
      const send = document.querySelector('[data-ac="send"]');
      return !send || send.getAttribute("data-ac-state") === "send";
    });
  await browser.waitUntil(idle, {
    timeout,
    timeoutMsg: "the turn never settled",
  });
}

/** Scripted provider with a fake key, Safe mode, and the given approval policy. */
export async function configureScriptedPlugin(mutating: "allow" | "ask" | "deny" = "ask"): Promise<void> {
  const ok = await browser.executeObsidian(async ({ app }, policy) => {
    const plugin = (app as unknown as {
      plugins?: { plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }> };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) return false;
    const settings = plugin.settings as {
      provider: string;
      openrouterApiKey: string;
      mode: string;
      approval: { mutating: string; perTool: Record<string, string> };
      web: { enabled: boolean };
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = "e2e-scripted-key";
    settings.mode = "safe";
    settings.approval.mutating = policy;
    settings.approval.perTool = {};
    settings.web.enabled = false;
    await plugin.saveSettings?.();
    return true;
  }, mutating);
  if (!ok) throw new Error("agentic-chat plugin not found in the test vault");
}

export async function noteExists(path: string): Promise<boolean> {
  return await browser.executeObsidian(async ({ app }, notePath) => app.vault.getAbstractFileByPath(notePath) != null, path);
}

export async function readNote(path: string): Promise<string> {
  return await browser.executeObsidian(async ({ app, obsidian }, notePath) => {
    const file = app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof obsidian.TFile)) return "";
    return await app.vault.read(file);
  }, path);
}

export async function trashPaths(paths: string[]): Promise<void> {
  await browser.executeObsidian(async ({ app, obsidian }, list) => {
    for (const path of list) {
      const file = app.vault.getAbstractFileByPath(path);
      if (file instanceof obsidian.TFile || file instanceof obsidian.TFolder) await app.vault.trash(file, true);
    }
  }, paths);
}

/**
 * An approval card that still waits for a choice. A settled card leaves the
 * transcript and its step row records the choice (U4 #4); a card with no step
 * row stays as a one-line record, so "gone" means "no pending card".
 */
export const PENDING_APPROVAL = '[data-ac="approval"]:not(.is-resolved)';

export async function waitForApproval(timeout = 10_000): Promise<void> {
  await $(PENDING_APPROVAL).waitForExist({ timeout, timeoutMsg: "no approval card appeared" });
}

export async function waitForApprovalSettled(timeout = 5_000): Promise<void> {
  await $(PENDING_APPROVAL).waitForExist({ reverse: true, timeout, timeoutMsg: "the approval card never settled" });
}

/**
 * The newest settled approval: allowed, always, denied, or stopped. Read from
 * the step row that records it (U4 #4), else from a one-line resolved card.
 */
export async function lastApprovalOutcome(): Promise<string | null> {
  return await browser.execute(() => {
    const recorded = Array.from(document.querySelectorAll('[data-ac="step"][data-ac-approval]')).at(-1);
    if (recorded) return recorded.getAttribute("data-ac-approval");
    return Array.from(document.querySelectorAll('[data-ac="approval"].is-resolved')).at(-1)?.getAttribute("data-ac-state") ?? null;
  });
}

export async function allowApproval(): Promise<void> {
  await waitForApproval();
  const allow = await $(`${PENDING_APPROVAL} [data-ac="approval-allow"]`);
  await allow.waitForExist({ timeout: 5_000 });
  await allow.click();
  await waitForApprovalSettled();
}

/** Allow and stop asking for this tool. */
export async function alwaysAllowApproval(): Promise<void> {
  await waitForApproval();
  const always = await $(`${PENDING_APPROVAL} [data-ac="approval-always"]`);
  await always.waitForExist({ timeout: 5_000 });
  await always.click();
  await waitForApprovalSettled();
}

/** Deny is two-step: the first click arms the optional reason field. */
export async function denyApproval(reason?: string): Promise<void> {
  await waitForApproval();
  const deny = await $(`${PENDING_APPROVAL} [data-ac="approval-deny"]`);
  await deny.waitForExist({ timeout: 5_000 });
  await deny.click();
  await browser.waitUntil(
    async () => (await $(PENDING_APPROVAL).getAttribute("data-ac-state")) === "deny-armed",
    { timeout: 5_000, timeoutMsg: "the deny never armed" },
  );
  expect(await deny.getText()).toBe("Confirm deny");
  if (reason) await browser.keys(reason);
  await deny.click();
  await waitForApprovalSettled();
}

/** Stop the turn from the composer while an approval waits. */
export async function stopFromComposer(): Promise<void> {
  await $('[data-ac="stop"]').click();
  await waitForApprovalSettled();
}

/** Settle an approval card a failed test left open, so the next test fails on
 * its own assertion and not on a turn that never ends. */
export async function dismissOpenApproval(): Promise<void> {
  if (!(await $(PENDING_APPROVAL).isExisting())) return;
  const stop = await $('[data-ac="stop"]');
  if (await stop.isDisplayed().catch(() => false)) await stop.click();
  await $(PENDING_APPROVAL).waitForExist({ reverse: true, timeout: 5_000 }).catch(() => {});
}
