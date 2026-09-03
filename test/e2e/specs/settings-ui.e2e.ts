import { browser, expect, $ } from "@wdio/globals";
import { before, describe, it } from "mocha";
import { createServer } from "node:http";
import { zipSync } from "../../../src/vendor/fflate";
import {
  clickMcpAddButton,
  clickSettingButton,
  openAgenticChatSettings,
  readAgenticChatSettings,
  readSecret,
  readStoredData,
  selectSettingsTab,
  setSettingRange,
  setSettingSelect,
  setSettingText,
  setSettingTextByPlaceholder,
  setSettingToggle,
  waitForMcpAddRow,
  waitForSettingButton,
  waitForAgenticChatSetting,
  waitForSetting,
} from "../support/settings-ui";

interface SettingsSnapshot {
  provider: string;
  openrouterApiKey: string;
  openaiCompatibleBaseUrl: string;
  openaiCompatibleApiKey: string;
  openaiCompatibleModel: string;
  approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
  web: { enabled: boolean; searchProvider: string; searchApiKey: string; searxngUrl: string; maxResults: number; fetchCharLimit: number };
  observability: {
    enabled: boolean;
    backend: string;
    endpoint: string;
    payloadMode: string;
    sampleRate: number;
    proxyUrl: string;
    noProxy: string;
    langfusePublicKey: string;
    langfuseSecretKey: string;
  };
  mcp: {
    enabled: boolean;
    servers: Array<{
      id: string;
      name: string;
      url: string;
      enabled: boolean;
      authType: string;
      authHeaderName: string;
      authHeaderValue: string;
      approval: string;
      source: string;
    }>;
  };
  plugins: { folder: string; sources?: Record<string, string>; mcpState?: Record<string, McpServerStateSnapshot> };
  ignoredGlobs: string;
}

interface McpServerStateSnapshot {
  enabled?: boolean;
  approval?: string;
  authType?: string;
  authHeaderName?: string;
  authHeaderValue?: string;
  authHeaderValueSecretId?: string;
  lastUrl?: string;
}
const OPENAI_COMPATIBLE_KEY_SECRET_ID = "agentic-chat-openai-compatible-api-key";
const OPENAI_COMPATIBLE_KEY = "e2e-openai-compatible-key";
const OPENROUTER_KEY_SECRET_ID = "agentic-chat-openrouter-api-key";
const OPENROUTER_KEY = "e2e-openrouter-key";
const WEB_SEARCH_KEY_SECRET_ID = "agentic-chat-web-search-api-key";
const WEB_SEARCH_KEY = "e2e-web-search-key";
const LANGFUSE_PUBLIC_KEY_SECRET_ID = "agentic-chat-langfuse-public-key";
const LANGFUSE_SECRET_KEY_SECRET_ID = "agentic-chat-langfuse-secret-key";

async function resetSettingsForUiSpec(): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    // Remove the generated package from a previous run so the MCP tab's
    // "Add MCP server" always produces the canonical "docs" package.
    const previous = app.vault.getAbstractFileByPath(".agentic-plugins/docs");
    if (previous) await app.vault.delete(previous, true);
  });
  await browser.executeObsidian(async ({ app }, secretId) => {
    const plugin = (app as unknown as {
      plugins?: {
        plugins?: Record<string, { settings?: Record<string, unknown>; saveSettings?: () => Promise<void> }>;
      };
      secretStorage?: { setSecret?: (id: string, value: string) => void };
    }).plugins?.plugins?.["agentic-chat"];
    if (!plugin?.settings) throw new Error("agentic-chat plugin not found");
    const settings = plugin.settings as {
      provider: string;
      openrouterApiKey: string;
      openaiCompatibleBaseUrl: string;
      openaiCompatibleApiKey: string;
      openaiCompatibleModel: string;
      approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
      web: { enabled: boolean; searchProvider: string; searchApiKeySecretId: string; searchApiKey: string; searxngUrl: string; maxResults: number; fetchCharLimit: number; allowedHosts: string };
      observability: {
        enabled: boolean;
        backend: string;
        endpoint: string;
        proxyUrl: string;
        noProxy: string;
        sampleRate: number;
        payloadMode: string;
        langfusePublicKeySecretId?: string;
        langfusePublicKey: string;
        langfuseSecretKeySecretId?: string;
        langfuseSecretKey: string;
        authHeaderName?: string;
        authHeaderValueSecretId?: string;
        authHeaderValue?: string;
      };
      mcp: { enabled: boolean; proxyUrl: string; noProxy: string; servers: unknown[] };
      plugins: {
        folder: string;
        enabled: Record<string, boolean>;
        sources: Record<string, string>;
        mcpState: Record<string, unknown>;
      };
      ignoredGlobs: string;
    };
    settings.provider = "openrouter";
    settings.openrouterApiKey = "";
    settings.openaiCompatibleBaseUrl = "https://api.openai.com/v1";
    settings.openaiCompatibleApiKey = "";
    settings.openaiCompatibleModel = "";
    settings.approval = { mutating: "ask", perTool: {}, workingDirs: [] };
    settings.web = {
      enabled: false,
      searchProvider: "tavily",
      searchApiKeySecretId: "agentic-chat-web-search-api-key",
      searchApiKey: "",
      searxngUrl: "",
      maxResults: 5,
      fetchCharLimit: 10_000,
      allowedHosts: "",
    };
    settings.mcp = {
      enabled: false,
      proxyUrl: "",
      noProxy: "localhost,127.0.0.1,::1",
      servers: [],
    };
    settings.observability = {
      enabled: false,
      backend: "langfuse",
      endpoint: "",
      proxyUrl: "",
      noProxy: "localhost,127.0.0.1,::1",
      sampleRate: 100,
      payloadMode: "metadata",
      langfusePublicKeySecretId: "agentic-chat-langfuse-public-key",
      langfusePublicKey: "",
      langfuseSecretKeySecretId: "agentic-chat-langfuse-secret-key",
      langfuseSecretKey: "",
      authHeaderName: "",
      authHeaderValueSecretId: "agentic-chat-observability-auth-header-value",
      authHeaderValue: "",
    };
    settings.plugins = { folder: ".agentic-plugins", enabled: {}, sources: {}, mcpState: {} };
    settings.ignoredGlobs = "";
    app.secretStorage?.setSecret?.(secretId, "");
    app.secretStorage?.setSecret?.("agentic-chat-langfuse-public-key", "");
    app.secretStorage?.setSecret?.("agentic-chat-langfuse-secret-key", "");
    await plugin.saveSettings?.();
  }, OPENAI_COMPATIBLE_KEY_SECRET_ID);
}

describe("agentic-chat settings UI", function () {
  before(async function () {
    await resetSettingsForUiSpec();
    await openAgenticChatSettings();
  });

  it("persists provider, API key, base URL, and model through the Models tab", async function () {
    await selectSettingsTab("Models");
    await setSettingSelect("Model provider", "openrouter");
    await waitForSetting("OpenRouter API key");
    await setSettingText("OpenRouter API key", OPENROUTER_KEY);

    await waitForAgenticChatSetting((settings) => {
      const snapshot = settings as unknown as SettingsSnapshot;
      return snapshot.provider === "openrouter" && snapshot.openrouterApiKey === OPENROUTER_KEY;
    }, "OpenRouter settings were not persisted from the settings UI");

    expect(await readSecret(OPENROUTER_KEY_SECRET_ID)).toBe(OPENROUTER_KEY);
    {
      const storedAfter = await readStoredData();
      expect("openrouterApiKey" in storedAfter).toBe(false);
    }

    await setSettingSelect("Model provider", "openai-compatible");
    await waitForSetting("Base URL");
    await setSettingText("Base URL", "https://llm.example/api");
    await setSettingText("API key", OPENAI_COMPATIBLE_KEY);
    await setSettingText("Model", "e2e/model-id");

    await waitForAgenticChatSetting((settings) => {
      const snapshot = settings as unknown as SettingsSnapshot;
      return (
        snapshot.provider === "openai-compatible" &&
        snapshot.openaiCompatibleBaseUrl === "https://llm.example/api" &&
        snapshot.openaiCompatibleApiKey === OPENAI_COMPATIBLE_KEY &&
        snapshot.openaiCompatibleModel === "e2e/model-id"
      );
    }, "OpenAI-compatible settings were not persisted from the settings UI");

    expect(await readSecret(OPENAI_COMPATIBLE_KEY_SECRET_ID)).toBe(OPENAI_COMPATIBLE_KEY);
    {
      const storedAfter = await readStoredData();
      expect(storedAfter.openaiCompatibleApiKey).toBeUndefined();
      expect("openaiCompatibleApiKey" in storedAfter).toBe(false);
    }
  });

  it("persists approval gates and per-tool overrides through the Approval tab", async function () {
    await selectSettingsTab("Approval");
    await setSettingSelect("Before mutating tools", "deny");
    await setSettingSelect("Write file", "ask");

    await waitForAgenticChatSetting((settings) => {
      const snapshot = settings as unknown as SettingsSnapshot;
      return snapshot.approval.mutating === "deny" && snapshot.approval.perTool.write === "ask";
    }, "Approval settings were not persisted from the settings UI");
  });

  it("persists web access settings through the Web tab", async function () {
    await selectSettingsTab("Web");
    await setSettingToggle("Enable web search & fetch", true);
    await waitForSetting("Search provider");
    await setSettingText("Search API key", WEB_SEARCH_KEY);

    await waitForAgenticChatSetting((settings) => {
      const snapshot = settings as unknown as SettingsSnapshot;
      return snapshot.web.enabled && snapshot.web.searchApiKey === WEB_SEARCH_KEY;
    }, "Web search API key was not persisted from the settings UI");

    expect(await readSecret(WEB_SEARCH_KEY_SECRET_ID)).toBe(WEB_SEARCH_KEY);
    {
      const storedAfter = await readStoredData();
      const storedWeb = storedAfter.web as Record<string, unknown>;
      expect("searchApiKey" in storedWeb).toBe(false);
    }

    await setSettingSelect("Search provider", "searxng");
    await waitForSetting("SearXNG instance URL");
    await setSettingText("SearXNG instance URL", "https://search.example.com");
    await setSettingRange("Search results", 7);
    await setSettingText("Fetched page character limit", "20000");

    await waitForAgenticChatSetting((settings) => {
      const snapshot = settings as unknown as SettingsSnapshot;
      return (
        snapshot.web.enabled &&
        snapshot.web.searchProvider === "searxng" &&
        snapshot.web.searxngUrl === "https://search.example.com" &&
        snapshot.web.maxResults === 7 &&
        snapshot.web.fetchCharLimit === 20_000
      );
    }, "Web settings were not persisted from the settings UI");
  });

  it("generates a plugin package and persists its MCP server through the MCP tab", async function () {
    await selectSettingsTab("MCP");
    await setSettingToggle("Enable MCP", true);
    await waitForMcpAddRow();
    await setSettingTextByPlaceholder("Server name", "docs");
    await setSettingTextByPlaceholder("https://mcp.example.com/mcp", "https://docs.example.com/mcp");
    await clickMcpAddButton("Add MCP server");
    await waitForSetting("Setup guide");
    await setSettingSelect("Approval", "allow");
    await setSettingSelect("Authentication", "header");
    await waitForSetting("Auth header");
    await setSettingText("Auth header", "X-E2E-Key");
    await setSettingText("Auth value", "mcp-secret");
    await waitForSettingButton("Setup guide", "Copy config");

    await waitForAgenticChatSetting((settings) => {
      const snapshot = settings as unknown as SettingsSnapshot;
      const state = snapshot.plugins.mcpState?.["plugin_docs_docs_889dfa93cd1a"];
      return (
        snapshot.mcp.enabled &&
        state?.enabled === true &&
        state?.lastUrl === "https://docs.example.com/mcp" &&
        state?.approval === "allow" &&
        state?.authType === "header" &&
        state?.authHeaderName === "X-E2E-Key" &&
        state?.authHeaderValue === "mcp-secret"
      );
    }, "MCP settings were not persisted from the settings UI");

    const mcpSettingsNow = await readAgenticChatSettings<SettingsSnapshot>();
    const mcpSecretIdForDocs = mcpSettingsNow.plugins.mcpState?.["plugin_docs_docs_889dfa93cd1a"]?.authHeaderValueSecretId;
    expect(mcpSecretIdForDocs).toBeTruthy();
    expect(await readSecret(mcpSecretIdForDocs as string)).toBe("mcp-secret");
    {
      const storedAfter = await readStoredData();
      const storedPlugins = storedAfter.plugins as {
        mcpState?: Record<string, Record<string, unknown>>;
      };
      const storedState = storedPlugins.mcpState?.["plugin_docs_docs_889dfa93cd1a"] ?? {};
      expect("authHeaderValue" in storedState).toBe(false);
    }
  });

  it("installs a plugin package from an archive URL through the Install plugin modal", async function () {
    this.timeout(30_000);
    const encoder = new TextEncoder();
    const packageZip = zipSync({
      "plugin.json": encoder.encode(
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "my-tool",
          version: "1.0.0",
          description: "E2E import fixture",
        }),
      ),
      "skills/my-tool/SKILL.md": encoder.encode("---\nname: my-tool\ndescription: E2E import fixture skill\n---\n# My tool\n\nUse it well."),
      "mcp.json": encoder.encode(
        JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          mcpServers: { files: { type: "streamable-http", url: "https://mcp.example.com/mcp" } },
        }),
      ),
    });
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/zip" });
      res.end(Buffer.from(packageZip));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("archive server did not bind");
    const archiveUrl = `http://127.0.0.1:${address.port}/my-tool.zip`;
    try {
      await selectSettingsTab("Resources");
      await clickSettingButton("Import", "Install plugin…");
      await browser.waitUntil(
        async () => (await $(".agentic-chat-install-url").isExisting()),
        { timeout: 5_000, timeoutMsg: "Install plugin modal did not open" },
      );
      // The modal lives outside the settings tab body, so drive it with
      // whole-document queries in the settings window.
      await browser.execute(
        (url) => {
          const input = Array.from(document.querySelectorAll<HTMLInputElement>("input.agentic-chat-install-url"));
          if (input.length === 0) throw new Error("Install URL input not found");
          const target = input[input.length - 1] as HTMLInputElement;
          target.value = url;
          target.dispatchEvent(new Event("input", { bubbles: true }));
          target.dispatchEvent(new Event("change", { bubbles: true }));
        },
        archiveUrl,
      );
      await browser.execute(() => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".setting-item button"))
          .find((candidate) => candidate.innerText.trim() === "Install");
        if (!button) throw new Error("Install button not found in modal");
        button.click();
      });

      await waitForAgenticChatSetting(
        (settings) => (settings as unknown as SettingsSnapshot).plugins.sources?.["my-tool"] === archiveUrl,
        "Imported package source was not persisted",
      );
      await waitForAgenticChatSetting((settings) => {
        const snapshot = settings as unknown as SettingsSnapshot;
        const key = Object.keys(snapshot.plugins.mcpState ?? {}).find((candidate) => candidate.startsWith("plugin_my_tool_"));
        return key !== undefined && snapshot.plugins.mcpState?.[key]?.enabled === false;
      }, "Imported MCP server did not persist disabled by default");

      await browser.waitUntil(
        async () => !(await $(".agentic-chat-install-url").isExisting()),
        { timeout: 5_000, timeoutMsg: "Install plugin modal did not close" },
      );
      await browser.waitUntil(
        async () =>
          await browser.execute(() => {
            const root = document.querySelector(".agentic-chat-settings-tabbody") ?? document;
            const text = root.textContent ?? "";
            return text.includes("my-tool") && text.includes("Source:");
          }),
        { timeout: 5_000, timeoutMsg: "Installed package row did not render in Resources" },
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("persists observability settings through the Observability tab", async function () {
    await selectSettingsTab("Observability");
    await setSettingToggle("Enable observability", true);
    await waitForSetting("Backend");
    await setSettingSelect("Backend", "langfuse");
    await waitForSetting("Langfuse base URL");
    await setSettingText("Langfuse base URL", "https://langfuse.corp.example");
    await setSettingSelect("Payload detail", "redacted-previews");
    await setSettingRange("Sample rate", 25);
    await setSettingText("HTTP proxy", "http://192.0.2.10:3128");
    await setSettingText("No proxy", "localhost,*.corp.example");
    await setSettingText("Langfuse public key", "pk-lf-e2e");
    await setSettingText("Langfuse secret key", "sk-lf-e2e");

    await waitForAgenticChatSetting((settings) => {
      const snapshot = settings as unknown as SettingsSnapshot;
      return (
        snapshot.observability.enabled &&
        snapshot.observability.backend === "langfuse" &&
        snapshot.observability.endpoint === "https://langfuse.corp.example" &&
        snapshot.observability.payloadMode === "redacted-previews" &&
        snapshot.observability.sampleRate === 25 &&
        snapshot.observability.proxyUrl === "http://192.0.2.10:3128" &&
        snapshot.observability.noProxy === "localhost,*.corp.example" &&
        snapshot.observability.langfusePublicKey === "pk-lf-e2e" &&
        snapshot.observability.langfuseSecretKey === "sk-lf-e2e"
      );
    }, "Observability settings were not persisted from the settings UI");

    expect(await readSecret(LANGFUSE_PUBLIC_KEY_SECRET_ID)).toBe("pk-lf-e2e");
    expect(await readSecret(LANGFUSE_SECRET_KEY_SECRET_ID)).toBe("sk-lf-e2e");
    const stored = await readStoredData();
    const storedObservability = stored.observability as { langfusePublicKey?: string; langfuseSecretKey?: string; authHeaderValue?: string };
    expect(storedObservability.langfusePublicKey).toBeUndefined();
    expect(storedObservability.langfuseSecretKey).toBeUndefined();
    expect(storedObservability.authHeaderValue).toBeUndefined();
    expect("langfusePublicKey" in storedObservability).toBe(false);
    expect("langfuseSecretKey" in storedObservability).toBe(false);
    expect("authHeaderValue" in storedObservability).toBe(false);
  });

  it("persists plugin folder and ignored globs through the Resources tab", async function () {
    await selectSettingsTab("Resources");
    await setSettingText("Plugins folder", ".agentic-plugins-e2e");
    await setSettingText("Ignore list", "Private/\n*.secret.md");

    const settings = await readAgenticChatSettings<SettingsSnapshot>();
    expect(settings.plugins.folder).toBe(".agentic-plugins-e2e");
    expect(settings.ignoredGlobs).toBe("Private/\n*.secret.md");
  });
});
