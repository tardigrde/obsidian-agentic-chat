import { describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";
import { createMcpServerSettings } from "../../src/mcp/settings";
import { endMcpOAuthProgress, handleMcpOAuthProgress, showMobileSignInButtons } from "../../src/settings-mcp-section";

describe("mobile OAuth sign-in notice", () => {
  const url = "https://auth.example.com/authorize?state=abc";

  function showButtons() {
    const setMessage = vi.spyOn(Notice.prototype, "setMessage");
    const server = createMcpServerSettings({ id: "docs", name: "docs", url: "https://mcp.example.com/mcp" });
    showMobileSignInButtons(server, url);
    const fragment = setMessage.mock.calls.at(-1)?.[0] as unknown as DocumentFragment;
    return { server, fragment, setMessage };
  }

  it("shows a real link to the sign-in page and a Copy button, in one button row", () => {
    const { server, fragment, setMessage } = showButtons();
    const row = fragment.querySelector(".agentic-chat-signin-actions");
    expect(row).not.toBeNull();
    const link = row?.querySelector<HTMLAnchorElement>("a.agentic-chat-signin-open");
    expect(link?.getAttribute("href")).toBe(url);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.textContent).toBe("Open sign-in page");
    expect(row?.querySelector("button")?.textContent).toBe("Copy link");
    endMcpOAuthProgress(server);
    setMessage.mockRestore();
  });

  it("keeps the buttons when later progress stages arrive", () => {
    const { server, setMessage } = showButtons();
    const before = setMessage.mock.calls.length;
    handleMcpOAuthProgress(server, { stage: "callback-wait", message: "Waiting for docs OAuth browser callback." });
    expect(setMessage.mock.calls.length).toBe(before);
    endMcpOAuthProgress(server);
    // After the flow ends, a new sign-in can show progress again.
    handleMcpOAuthProgress(server, { stage: "discovery", message: "Discovering OAuth metadata for docs." });
    handleMcpOAuthProgress(server, { stage: "registration", message: "Preparing OAuth client for docs." });
    expect(setMessage.mock.calls.length).toBe(before + 1);
    endMcpOAuthProgress(server);
    setMessage.mockRestore();
  });
});
