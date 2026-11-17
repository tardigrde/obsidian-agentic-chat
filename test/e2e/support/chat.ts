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
  await $(".agentic-chat-view").waitForExist();
  await waitForComposerReady();
}

/** Type into the composer and press its send control, like a user. */
export async function sendPrompt(prompt: string): Promise<void> {
  await waitForComposerReady();
  const input = await $(".agentic-chat-input");
  await input.click();
  await input.setValue(prompt);
  await $(".agentic-chat-send").click();
}

/** Set the composer value and click send in one page call. Same submit route
 * as Enter, without version-specific WebDriver key synthesis. */
export async function submitComposer(value: string): Promise<void> {
  await waitForComposerReady();
  await browser.execute((text) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
    const send = document.querySelector<HTMLButtonElement>(".agentic-chat-send");
    if (!textarea || !send) throw new Error("agentic-chat composer is not mounted");
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    send.click();
  }, value);
}

export async function transcriptText(): Promise<string> {
  return await browser.execute(() => document.querySelector<HTMLElement>(".agentic-chat-messages")?.innerText ?? "");
}

export async function waitForTranscript(text: string, timeout = 10_000): Promise<void> {
  await browser.waitUntil(async () => (await transcriptText()).includes(text), {
    timeout,
    timeoutMsg: `transcript never showed ${JSON.stringify(text)}`,
  });
}

/** Text of the newest info block (slash-command output). */
export async function latestInfoText(): Promise<string> {
  await $(".agentic-chat-info").waitForExist();
  return await browser.execute(() => {
    const infos = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-info"));
    return infos.at(-1)?.innerText ?? "";
  });
}

/** Wait until no turn is running (the Stop control is gone). */
export async function waitForIdle(timeout = 10_000): Promise<void> {
  await browser.waitUntil(async () => !(await $(".agentic-chat-stop").isDisplayed()), {
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

export async function allowApproval(): Promise<void> {
  const modal = await $(".agentic-chat-approval");
  await modal.waitForExist({ timeout: 10_000 });
  const allow = await modal.$("button=Allow");
  await allow.waitForExist({ timeout: 5_000 });
  await allow.click();
  await modal.waitForExist({ reverse: true, timeout: 5_000 });
}

/** Deny is two-step: the first click arms the optional reason field. */
export async function denyApproval(): Promise<void> {
  const modal = await $(".agentic-chat-approval");
  await modal.waitForExist({ timeout: 10_000 });
  const deny = await modal.$("button=Deny");
  await deny.waitForExist({ timeout: 5_000 });
  await deny.click();
  const confirmDeny = await modal.$("button=Confirm Deny");
  await confirmDeny.waitForExist({ timeout: 5_000 });
  const title = await browser.execute(
    () => document.querySelector(".agentic-chat-approval")?.closest(".modal")?.querySelector(".modal-title")?.textContent ?? "",
  );
  expect(title).toMatch(/^Deny "/);
  await confirmDeny.click();
  await modal.waitForExist({ reverse: true, timeout: 5_000 });
}

/** Close an approval modal a failed test left open, so the next test fails on
 * its own assertion and not on an intercepted click. */
export async function dismissOpenApproval(): Promise<void> {
  const modal = await $(".agentic-chat-approval");
  if (!(await modal.isExisting())) return;
  const deny = await modal.$("button=Deny");
  if (await deny.isExisting()) {
    await deny.click();
    const confirm = await modal.$("button=Confirm Deny");
    if (await confirm.isExisting()) await confirm.click();
  }
  await modal.waitForExist({ reverse: true, timeout: 5_000 }).catch(() => {});
  if (await modal.isExisting()) {
    const stop = await modal.$("button=Stop turn");
    if (await stop.isExisting()) await stop.click();
  }
  await modal.waitForExist({ reverse: true, timeout: 5_000 }).catch(() => {});
}
