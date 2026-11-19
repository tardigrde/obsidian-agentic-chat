import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { configureScriptedPlugin, openChat, submitComposer, waitForIdle, waitForTranscript } from "../support/chat";
import { clearScriptedTurns, installScriptedTurns, textTurn } from "../support/scripted-stream";

/**
 * A conversation can be open in one tab and deleted from another tab's history
 * list (or by `/sessions clear`). The tab that had it open must not keep
 * appending to the deleted file: that recreates it without a session header,
 * so the conversation vanishes from history and is lost on reload.
 */

type TabsView = {
  tabs: Array<{ service: { getSessionInfo: () => { path: string } | null } }>;
};

async function tabCount(): Promise<number> {
  return await browser.execute(() => document.querySelectorAll('[data-ac="tab"]').length);
}

async function addTab(): Promise<void> {
  const before = await tabCount();
  await browser.execute(() => document.querySelector<HTMLElement>('[data-ac="tab-add"]')?.click());
  await browser.waitUntil(async () => (await tabCount()) > before, { timeout: 5_000, timeoutMsg: "no new tab" });
}

async function selectTab(index: number): Promise<void> {
  await browser.execute((target) => {
    document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[target]?.click();
  }, index);
  await browser.waitUntil(
    async () =>
      await browser.execute(
        (target) => document.querySelectorAll<HTMLElement>('[data-ac="tab"]')[target]?.classList.contains("is-active"),
        index,
      ),
    { timeout: 5_000, timeoutMsg: `tab ${index} never became active` },
  );
}

async function tabSessionPath(index: number): Promise<string> {
  return await browser.executeObsidian(({ app }, target) => {
    const view = app.workspace.getLeavesOfType("agentic-chat-chat-view")[0]?.view as unknown as TabsView;
    return view.tabs[target]?.service.getSessionInfo()?.path ?? "";
  }, index);
}

/** First line of every session file; a valid file starts with a `session` header. */
async function sessionFileHeads(): Promise<Array<{ path: string; head: string }>> {
  return await browser.executeObsidian(async ({ app }) => {
    const dir = `${app.vault.configDir}/plugins/agentic-chat/sessions`;
    const listing = await app.vault.adapter.list(dir);
    const files = listing.files.filter((path) => path.endsWith(".jsonl"));
    return await Promise.all(
      files.map(async (path) => {
        const text = await app.vault.adapter.read(path);
        return { path, head: (text.split("\n")[0] ?? "").slice(0, 80) };
      }),
    );
  });
}

async function deleteFromHistory(firstMessage: string): Promise<void> {
  await $('[aria-label="Conversation history"]').click();
  await $(".agentic-chat-session-list").waitForExist();
  await browser.waitUntil(
    async () =>
      await browser.execute(
        (text) =>
          Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-session-row")).some((row) =>
            row.innerText.toLowerCase().includes(text.toLowerCase()),
          ),
        firstMessage,
      ),
    { timeout: 5_000, timeoutMsg: `history never listed ${firstMessage}` },
  );
  await browser.execute((text) => {
    const row = Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-session-row")).find((entry) =>
      entry.innerText.toLowerCase().includes(text.toLowerCase()),
    );
    row?.querySelector<HTMLButtonElement>(".agentic-chat-session-delete")?.click();
  }, firstMessage);
  await browser.waitUntil(
    async () =>
      await browser.execute(
        (text) =>
          !Array.from(document.querySelectorAll<HTMLElement>(".agentic-chat-session-row")).some((row) =>
            row.innerText.toLowerCase().includes(text.toLowerCase()),
          ),
        firstMessage,
      ),
    { timeout: 5_000, timeoutMsg: "the deleted row stayed in the list" },
  );
  await browser.keys("Escape");
  await browser.waitUntil(async () => !(await $(".agentic-chat-session-list").isExisting()), {
    timeout: 5_000,
    timeoutMsg: "the history modal did not close",
  });
}

describe("session delete across tabs", function () {
  before(async function () {
    await installScriptedTurns([
      textTurn("tab zero", "Tab zero answer."),
      textTurn("tab one", "Tab one answer."),
      textTurn("tab one after delete", "Tab one keeps going."),
      textTurn("tab one after clear", "Tab one after clear."),
    ]);
    await configureScriptedPlugin("allow");
    await openChat();
  });

  after(async function () {
    await clearScriptedTurns();
  });

  it("a tab whose conversation is deleted from another tab keeps a valid, listed session", async function () {
    await submitComposer("tab zero conversation");
    await waitForTranscript("Tab zero answer.");
    await waitForIdle();

    await addTab();
    await selectTab(1);
    await submitComposer("tab one conversation");
    await waitForTranscript("Tab one answer.");
    await waitForIdle();
    const deletedPath = await tabSessionPath(1);
    expect(deletedPath).not.toBe("");

    await selectTab(0);
    await deleteFromHistory("tab one conversation");

    await selectTab(1);
    await submitComposer("tab one after the delete");
    await waitForTranscript("Tab one keeps going.");
    await waitForIdle();

    const heads = await sessionFileHeads();
    const broken = heads.filter((file) => !file.head.includes('"type":"session"'));
    expect(broken).toEqual([]);
    expect(heads.some((file) => file.path === deletedPath)).toBe(false);
    expect(await tabSessionPath(1)).not.toBe(deletedPath);
    // The deleted conversation is in the vault trash, so the user can get it back.
    const trashed = await browser.executeObsidian(async ({ app }, name) => {
      if (!(await app.vault.adapter.exists(".trash"))) return false;
      const listing = await app.vault.adapter.list(".trash");
      return listing.files.some((path) => path.endsWith(name));
    }, deletedPath.slice(deletedPath.lastIndexOf("/") + 1));
    expect(trashed).toBe(true);
  });

  it("/sessions clear in one tab leaves the other tab on a valid, listed session", async function () {
    const before = await tabSessionPath(1);
    expect(before).not.toBe("");
    await selectTab(0);
    await submitComposer("/sessions clear --confirm");
    await waitForTranscript("Deleted");

    await selectTab(1);
    await submitComposer("tab one after the clear");
    await waitForTranscript("Tab one after clear.");
    await waitForIdle();

    const heads = await sessionFileHeads();
    expect(heads.filter((file) => !file.head.includes('"type":"session"'))).toEqual([]);
    expect(heads.some((file) => file.path === before)).toBe(false);
  });

  it("history shows an unreadable session file as a row the user can delete", async function () {
    const brokenPath = await browser.executeObsidian(async ({ app }) => {
      const path = `${app.vault.configDir}/plugins/agentic-chat/sessions/2026-01-01T00-00-00-000Z_broken.jsonl`;
      // A file with no session header, as a crash or a stray append leaves it.
      await app.vault.adapter.write(path, '{"type":"action_audit"}\n');
      return path;
    });

    await $('[aria-label="Conversation history"]').click();
    await $(".agentic-chat-session-list").waitForExist();
    const row = $(".agentic-chat-session-row.is-unreadable");
    await row.waitForExist({ timeout: 5_000, timeoutMsg: "history hid the unreadable session file" });
    await expect(row.$(".agentic-chat-session-title")).toHaveText(
      "Unreadable conversation (2026-01-01T00-00-00-000Z_broken.jsonl)",
    );
    expect(await row.$(".agentic-chat-session-rename").isExisting()).toBe(false);
    if (process.env.AGENTIC_CHAT_SCREENSHOT_DIR) {
      await browser.saveScreenshot(`${process.env.AGENTIC_CHAT_SCREENSHOT_DIR}/unreadable-session-row.png`);
    }

    await row.$(".agentic-chat-session-delete").click();
    await browser.waitUntil(async () => !(await $(".agentic-chat-session-row.is-unreadable").isExisting()), {
      timeout: 5_000,
      timeoutMsg: "the unreadable row stayed in the list",
    });
    await browser.keys("Escape");
    const heads = await sessionFileHeads();
    expect(heads.some((file) => file.path === brokenPath)).toBe(false);
  });
});
