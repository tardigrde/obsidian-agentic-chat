import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";

/**
 * Inline images in the chat pane (#142), deterministic and model-free:
 * drives the live view against a real running Obsidian with a seeded vault PNG.
 */

const VIEW_TYPE_AGENT_CHAT = "agentic-chat-chat-view";
const IMAGE_PATH = "E2E Images/inline-pic.png";
// 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function emit(event: Record<string, unknown>): Promise<void> {
  await browser.executeObsidian(
    async ({ app }, viewType, ev) => {
      const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
        handleAgentEvent?: (event: unknown) => void;
      };
      if (!view?.handleAgentEvent) throw new Error(`chat view missing handleAgentEvent for ${viewType}`);
      view.handleAgentEvent(ev);
    },
    VIEW_TYPE_AGENT_CHAT,
    event,
  );
}

async function lastBubbleImages(selector: string): Promise<string[]> {
  return browser.execute((sel) => {
    const bubbles = Array.from(document.querySelectorAll(sel));
    const last = bubbles.at(-1);
    return last ? Array.from(last.querySelectorAll("img")).map((img) => img.getAttribute("src") ?? "") : [];
  }, selector);
}

describe("agentic-chat inline images", function () {
  before(async function () {
    await browser.executeObsidian(
      async ({ app }, path, base64) => {
        const folder = path.split("/")[0];
        if (!app.vault.getFolderByPath(folder)) await app.vault.createFolder(folder);
        const existing = app.vault.getFileByPath(path);
        if (existing) await app.vault.delete(existing);
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        await app.vault.createBinary(path, bytes.buffer);
      },
      IMAGE_PATH,
      PNG_BASE64,
    );
    await browser.executeObsidianCommand("agentic-chat:open-chat");
    await $(".agentic-chat-view").waitForExist();
  });

  it("renders vault image embeds in assistant markdown and leaves code untouched", async function () {
    const text = [
      "Wiki embed: ![[inline-pic.png]]",
      "",
      `Markdown: ![pic](${encodeURI(IMAGE_PATH)})`,
      "",
      "Code span: `![[inline-pic.png]]`",
    ].join("\n");
    await emit({ type: "agent_start" });
    await emit({ type: "message_start", message: { role: "assistant", content: [] } });
    await emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
    await emit({ type: "agent_end", messages: [] });

    await browser.waitUntil(async () => (await lastBubbleImages(".agentic-chat-assistant")).length >= 2, {
      timeout: 5000,
      timeoutMsg: "assistant bubble did not render two images",
    });
    const srcs = await lastBubbleImages(".agentic-chat-assistant");
    expect(srcs).toHaveLength(2);
    for (const src of srcs) expect(src).toMatch(/^app:\/\//);
    const styled = await browser.execute(
      () => document.querySelectorAll(".agentic-chat-assistant img.agentic-chat-image").length,
    );
    expect(styled).toBeGreaterThanOrEqual(2);
    const codeText = await browser.execute(() => {
      const bubbles = Array.from(document.querySelectorAll(".agentic-chat-assistant"));
      return bubbles.at(-1)?.querySelector("code")?.textContent ?? "";
    });
    expect(codeText).toBe("![[inline-pic.png]]");
  });

  it("shows one thumbnail per attached image on a live send", async function () {
    // Same arguments as the send path: the attachment path plus the vision block
    // loaded from it.
    await browser.executeObsidian(
      async ({ app }, viewType, path, base64) => {
        const view = app.workspace.getLeavesOfType(viewType)[0]?.view as unknown as {
          renderOutgoingUserMessage: (text: string, attachments: string[], images?: unknown[]) => void;
        };
        view.renderOutgoingUserMessage("what is in this picture?", [path], [
          { type: "image", data: base64, mimeType: "image/png" },
        ]);
      },
      VIEW_TYPE_AGENT_CHAT,
      IMAGE_PATH,
      PNG_BASE64,
    );
    const srcs = await lastBubbleImages(".agentic-chat-user");
    expect(srcs).toHaveLength(1);
    expect(srcs[0]).toMatch(/^app:\/\//);
    // Clicking the thumbnail opens the vault image.
    await browser.execute(() => {
      const bubbles = Array.from(document.querySelectorAll(".agentic-chat-user"));
      (bubbles.at(-1)?.querySelector("img.is-openable") as HTMLElement | null)?.click();
    });
    await browser.waitUntil(
      async () =>
        (await browser.executeObsidian(({ app }) => app.workspace.getActiveFile()?.path ?? "")) === IMAGE_PATH,
      { timeout: 5000, timeoutMsg: "thumbnail click did not open the vault image" },
    );
    await browser.executeObsidianCommand("agentic-chat:open-chat");
    await $(".agentic-chat-view").waitForExist();
    // The service echoes the sent user turn; the view skips it (already rendered).
    const before = await browser.execute(() => document.querySelectorAll(".agentic-chat-user").length);
    await emit({
      type: "message_end",
      message: {
        role: "user",
        content: [
          { type: "text", text: "what is in this picture?" },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        ],
      },
    });
    expect(await browser.execute(() => document.querySelectorAll(".agentic-chat-user").length)).toBe(before);
  });

  it("renders a replayed vision block as a thumbnail", async function () {
    await emit({
      type: "message_end",
      message: {
        role: "user",
        content: [
          { type: "text", text: "from history" },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
        ],
      },
    });
    const srcs = await lastBubbleImages(".agentic-chat-user");
    expect(srcs).toEqual([`data:image/png;base64,${PNG_BASE64}`]);
  });
});
