import { browser, $ } from "@wdio/globals";
import { describe, it, before } from "mocha";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { zipSync } from "../../../src/vendor/fflate";
import {
  clickSettingButton,
  openAgenticChatSettings,
  readAgenticChatSettings,
  selectSettingsTab,
} from "../support/settings-ui";

interface SettingsSnapshot {
  mcp: { servers: Array<{ id: string; url: string; enabled: boolean; source: string }> };
  plugins: {
    sources?: Record<string, string>;
    mcpState?: Record<string, { enabled: boolean; lastUrl?: string }>;
  };
}

describe("composio bundle install (Cursor → Agent Plugins)", function () {
  before(async function () {
    await openAgenticChatSettings();
    await selectSettingsTab("Resources");
  });

  it("installs Composio bundle via archive URL and verifies 2 skills + 1 MCP (popout-safe)", async function () {
    this.timeout(30_000);
    const encoder = new TextEncoder();
    const composioZip = zipSync({
      ".cursor-plugin/plugin.json": encoder.encode(
        JSON.stringify({
          name: "composio",
          description: "Connect and operate 1000+ external apps via Composio MCP server.",
          version: "1.0.0",
          mcpServers: "../mcp.json",
          skills: "./skills/",
          author: { name: "Composio" },
          homepage: "https://composio.dev",
          repository: "https://github.com/ComposioHQ/composio-mcp-plugin",
          license: "MIT",
        }),
      ),
      "mcp.json": encoder.encode(
        JSON.stringify({ mcpServers: { composio: { url: "https://connect.composio.dev/mcp" } } }),
      ),
      "skills/composio-mcp/SKILL.md": encoder.encode(
        "---\nname: composio-mcp\ndescription: Use the Composio Connect MCP server to interact with 1000+ apps — GitHub, Slack, Notion, Gmail, Linear, Jira, and more.\n---\n# Composio Connect MCP\n\nUse COMPOSIO_SEARCH_TOOLS first.\n",
      ),
      "skills/composio-activity-summary/SKILL.md": encoder.encode(
        "---\nname: composio-activity-summary\ndescription: Generate a cross-app company activity summary (Slack, GitHub, Notion, Linear, Gmail, and more) for a given time period.\n---\n# Activity Summary\n\nSummarize.\n",
      ),
    });

    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/zip" });
      res.end(Buffer.from(composioZip));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/composio-mcp-plugin.zip`;

    try {
      await selectSettingsTab("Resources");
      await clickSettingButton("Import", "Install plugin…");
      await browser.waitUntil(async () => await $(".agentic-chat-install-url").isExisting(), {
        timeout: 5_000,
        timeoutMsg: "Install plugin modal did not open (popout HierarchyRequestError?)",
      });

      await browser.execute(
        (u) => {
          const input = Array.from(document.querySelectorAll<HTMLInputElement>("input.agentic-chat-install-url")).pop();
          if (!input) throw new Error("Install URL input not found");
          input.value = u;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        },
        url,
      );
      await browser.execute(() => {
        const btn = Array.from(document.querySelectorAll<HTMLButtonElement>(".setting-item button")).find((b) => b.innerText.trim() === "Install");
        if (!btn) throw new Error("Install button not found in modal");
        btn.click();
      });

      await browser.waitUntil(
        async () => {
          const s = (await readAgenticChatSettings()) as unknown as SettingsSnapshot;
          return s.plugins.sources?.["composio"] === url;
        },
        { timeout: 10_000, timeoutMsg: "Composio source not persisted" },
      );

      await browser.waitUntil(
        async () => {
          const s = (await readAgenticChatSettings()) as unknown as SettingsSnapshot;
          // After S10, plugin MCP servers live in plugins.mcpState, not mcp.servers
          const mcpState = s.plugins.mcpState ?? {};
          const entry = Object.entries(mcpState).find(([id]) => id.startsWith("plugin_composio_com"));
          if (!entry) return false;
          const [, state] = entry;
          return state.enabled === false && state.lastUrl === "https://connect.composio.dev/mcp" && (state as unknown as { authType?: string }).authType === "oauth";
        },
        { timeout: 10_000, timeoutMsg: "Composio MCP server not persisted disabled with oauth and correct URL in plugins.mcpState" },
      );

      await browser.waitUntil(async () => !(await $(".agentic-chat-install-url").isExisting()), {
        timeout: 5_000,
        timeoutMsg: "Install modal did not close",
      });

      await browser.waitUntil(
        async () =>
          await browser.execute(() => {
            const root = document.querySelector(".agentic-chat-settings-tabbody") ?? document;
            const t = root.textContent ?? "";
            return t.includes("composio") && t.includes("2 skills, 1 MCP server");
          }),
        { timeout: 5_000, timeoutMsg: "Composio row did not render with 2 skills, 1 MCP server" },
      );

      // Verify OAuth is default for composio — check in MCP tab where auth UI lives
      await selectSettingsTab("MCP");
      // Enable MCP globally first (disabled by default in fresh vault)
      await browser.execute(() => {
        const root = document.querySelector(".agentic-chat-settings-tabbody") ?? document;
        const enableRow = Array.from(root.querySelectorAll<HTMLElement>(".setting-item")).find((el) => el.textContent?.includes("Enable MCP"));
        const toggle = enableRow?.querySelector<HTMLElement>(".checkbox-container");
        if (toggle && toggle.getAttribute("aria-checked") !== "true") (toggle as HTMLElement).click();
      });
      await browser.waitUntil(
        async () =>
          await browser.execute(() => {
            const root = document.querySelector(".agentic-chat-settings-tabbody") ?? document;
            const t = root.textContent ?? "";
            return t.includes("composio: composio") && t.includes("OAuth not authenticated");
          }),
        { timeout: 5_000, timeoutMsg: "Composio OAuth not default in MCP tab — expected OAuth not authenticated" },
      );

      // Enable the specific server and verify Test button becomes Authenticate & test
      await browser.execute(() => {
        const root = document.querySelector(".agentic-chat-settings-tabbody") ?? document;
        const row = Array.from(root.querySelectorAll<HTMLElement>(".setting-item")).find((el) => el.textContent?.includes("composio: composio"));
        const toggle = row?.querySelector<HTMLElement>(".checkbox-container");
        if (toggle && toggle.getAttribute("aria-checked") !== "true") (toggle as HTMLElement).click();
      });
      await browser.waitUntil(
        async () =>
          await browser.execute(() => {
            const btns = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
            return btns.some((b) => b.innerText.trim() === "Authenticate & test");
          }),
        { timeout: 5_000, timeoutMsg: "Authenticate & test button not found after enabling composio MCP" },
      );
      // Back to Resources for final checks
      await selectSettingsTab("Resources");

      // UI already verified 2 skills, 1 MCP via row text and mcpState; disk check via adapter is covered by loader
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Cleanup: remove composio plugin via main window (settings popout has no wdio service)
      try {
        const handles = await browser.getWindowHandles();
        const mainHandle = handles[0];
        await browser.switchToWindow(mainHandle);
        await browser.executeObsidian(async ({ app }) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vault: any = (app as any).vault;
          const existing = vault.getAbstractFileByPath(".agentic-plugins/composio");
          if (existing) await vault.delete(existing, true);
          else if (await vault.adapter.exists(".agentic-plugins/composio")) await vault.adapter.rmdir(".agentic-plugins/composio", true);
        });
        const settingsHandle = (await browser.getWindowHandles()).find((h) => h !== mainHandle) ?? mainHandle;
        await browser.switchToWindow(settingsHandle);
      } catch {} // eslint-disable-line no-empty
    }
  });

  it("shows OAuth banner for bare MCP when 401 advertises resource_metadata (no auto-redirect)", async function () {
    this.timeout(20_000);
    // Create a bare MCP server (source user) with pending OAuth challenge (simulates 401 with resource_metadata)
    const handlesBare = await browser.getWindowHandles();
    const mainBare = handlesBare[0];
    await browser.switchToWindow(mainBare);
    await browser.executeObsidian(async ({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plugin: any = (app as any).plugins.plugins["agentic-chat"];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mcp: any = plugin.settings.mcp;
      mcp.enabled = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!mcp.servers.find((s: any) => s.id === "e2e-bare-oauth")) {
        mcp.servers.push({
          id: "e2e-bare-oauth",
          name: "e2e-bare-oauth",
          url: "https://mcp.example.com/mcp",
          enabled: true,
          authType: "none",
          authHeaderName: "",
          authHeaderValue: "",
          authHeaderValueSecretId: "test",
          oauth: {
            clientId: "",
            clientSecret: "",
            clientSecretSecretId: "",
            dynamicClientRegistration: false,
            registeredRedirectUri: "",
            authorizationServer: "",
            authorizationEndpoint: "",
            tokenEndpoint: "",
            registrationEndpoint: "",
            resourceMetadataUrl: "",
            accessToken: "",
            accessTokenSecretId: "",
            refreshToken: "",
            refreshTokenSecretId: "",
            expiresAt: 0,
            scope: "",
          },
          approval: "ask",
          knownTools: [],
          headers: {},
          source: "user",
          enabledTools: [],
          disabledTools: [],
          pendingOAuthChallenge: 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
          pendingOAuthResourceUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
        });
        await plugin.saveSettings();
      }
    });
    const settingsBare = (await browser.getWindowHandles()).find((h) => h !== mainBare) ?? mainBare;
    await browser.switchToWindow(settingsBare);
    await selectSettingsTab("MCP");
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const t = document.body.textContent ?? "";
          return t.includes("requires OAuth") && t.includes("Authenticate & test");
        }),
      { timeout: 5_000, timeoutMsg: "Bare MCP OAuth banner not shown" },
    );
    // For none, banner shows "Click Authenticate & test" without Switch button; just verify Authenticate button exists
    await browser.waitUntil(
      async () =>
        await browser.execute(() => {
          const btns = Array.from(document.querySelectorAll("button"));
          return btns.some((b) => b.innerText.trim() === "Authenticate & test");
        }),
      { timeout: 5_000, timeoutMsg: "Authenticate & test not shown for bare OAuth banner" },
    );
    // Cleanup bare server
    const handlesCleanupBare = await browser.getWindowHandles();
    const mainCleanupBare = handlesCleanupBare[0];
    await browser.switchToWindow(mainCleanupBare);
    await browser.executeObsidian(async ({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plugin: any = (app as any).plugins.plugins["agentic-chat"];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      plugin.settings.mcp.servers = plugin.settings.mcp.servers.filter((s: any) => s.id !== "e2e-bare-oauth");
      await plugin.saveSettings();
    });
    const settingsCleanupBare = (await browser.getWindowHandles()).find((h) => h !== mainCleanupBare) ?? mainCleanupBare;
    await browser.switchToWindow(settingsCleanupBare);
  });
});
