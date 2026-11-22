import { afterEach, describe, expect, it, vi } from "vitest";
import { Notice, Platform } from "obsidian";
import { createMcpServerSettings } from "../../src/mcp/settings";
import { endMcpOAuthProgress, handleMcpOAuthProgress } from "../../src/settings-mcp-section";

describe("mobile OAuth sign-in notice", () => {
  const url = "https://auth.example.com/authorize?state=abc";
  const server = createMcpServerSettings({ id: "docs", name: "docs", url: "https://mcp.example.com/mcp" });
  const platform = Platform as { isMobileApp: boolean };
  const wasMobile = platform.isMobileApp;

  afterEach(() => {
    endMcpOAuthProgress(server);
    platform.isMobileApp = wasMobile;
    vi.restoreAllMocks();
  });

  /** Run the sign-in stages the way the flow does and return what the notice shows last. */
  function runSignIn(stages: Array<"authorization-url" | "browser-open" | "callback-wait">) {
    const setMessage = vi.spyOn(Notice.prototype, "setMessage");
    handleMcpOAuthProgress(server, { stage: "discovery", message: "Discovering OAuth metadata for docs." });
    for (const stage of stages) {
      handleMcpOAuthProgress(server, { stage, message: `stage ${stage}`, detail: stage === "authorization-url" ? url : undefined });
    }
    return setMessage.mock.calls.at(-1)?.[0] as unknown;
  }

  it("shows a real link to the sign-in page and a Copy button, in one button row", () => {
    platform.isMobileApp = true;
    const last = runSignIn(["authorization-url"]);
    expect(typeof last).toBe("object");
    const fragment = last as DocumentFragment;
    const row = fragment.querySelector(".agentic-chat-signin-actions");
    expect(row).not.toBeNull();
    const link = row?.querySelector<HTMLAnchorElement>("a.agentic-chat-signin-open");
    expect(link?.getAttribute("href")).toBe(url);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.textContent).toBe("Open sign-in page");
    expect(row?.querySelector("button")?.textContent).toBe("Copy link");
  });

  it("keeps the buttons when later progress stages arrive", () => {
    platform.isMobileApp = true;
    const last = runSignIn(["authorization-url", "browser-open", "callback-wait"]);
    expect(typeof last).toBe("object");
    expect((last as DocumentFragment).querySelector("a.agentic-chat-signin-open")).not.toBeNull();
  });

  it("does not show the buttons on desktop", () => {
    platform.isMobileApp = false;
    const last = runSignIn(["authorization-url", "browser-open"]);
    expect(typeof last).toBe("string");
  });
});
