import { describe, expect, it, vi } from "vitest";
import { Notice } from "obsidian";
import { createMcpServerSettings } from "../../src/mcp/settings";
import { endMcpOAuthProgress, handleMcpOAuthProgress, showMobileSignInButtons } from "../../src/settings-mcp-section";
import { keyboardOverlap } from "../../src/ui/keyboard-overlap";

describe("keyboard overlap (phone drawer)", () => {
  it("counts only the part of the view the keyboard covers", () => {
    // Owner phone readout: view bottom 704, app container bottom 504 (812 - 308 keyboard).
    expect(keyboardOverlap(704, 504)).toBe(200);
  });

  it("is 0 when the keyboard is closed or the view already shrank", () => {
    expect(keyboardOverlap(704, 812)).toBe(0);
    expect(keyboardOverlap(504, 504)).toBe(0);
  });

  it("is 0 when a number is missing", () => {
    expect(keyboardOverlap(Number.NaN, 504)).toBe(0);
    expect(keyboardOverlap(704, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

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
