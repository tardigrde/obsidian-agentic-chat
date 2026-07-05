import { browser, expect } from "@wdio/globals";
import { before, describe, it } from "mocha";
import {
  clickSettingButton,
  openAgenticChatSettings,
  readAgenticChatSettings,
  selectSettingsTab,
  setSettingRange,
  setSettingSelect,
  setSettingText,
  setSettingToggle,
  waitForSettingButton,
  waitForAgenticChatSetting,
  waitForSetting,
} from "../support/settings-ui";

interface SettingsSnapshot {
  provider: string;
  openaiCompatibleBaseUrl: string;
  openaiCompatibleApiKey: string;
  openaiCompatibleModel: string;
  approval: { mutating: string; perTool: Record<string, string>; workingDirs: string[] };
  web: { enabled: boolean; searchProvider: string; searxngUrl: string; maxResults: number; fetchCharLimit: number };
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
    }>;
  };
  skillsFolder: string;
  templatesFolder: string;
  enableBuiltinAgents: boolean;
  agentsFolder: string;
  ignoredGlobs: string;
}

const OPENAI_COMPATIBLE_KEY_SECRET_ID = "agentic-chat-openai-compatible-api-key";
const OPENAI_COMPATIBLE_KEY = "e2e-openai-compatible-key";
const LANGFUSE_PUBLIC_KEY_SECRET_ID = "agentic-chat-langfuse-public-key";
const LANGFUSE_SECRET_KEY_SECRET_ID = "agentic-chat-langfuse-secret-key";

async function resetSettingsForUiSpec(): Promise<void> {
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
      web: { enabled: boolean; searchProvider: string; searchApiKey: string; searxngUrl: string; maxResults: number; fetchCharLimit: number };
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
      skillsFolder: string;
      templatesFolder: string;
      enableBuiltinAgents: boolean;
      agentsFolder: string;
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
      searchApiKey: "",
      searxngUrl: "",
      maxResults: 5,
      fetchCharLimit: 10_000,
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
    settings.skillsFolder = "";
    settings.templatesFolder = "";
    settings.enableBuiltinAgents = true;
    settings.agentsFolder = "";
    settings.ignoredGlobs = "";
    app.secretStorage?.setSecret?.(secretId, "");
    app.secretStorage?.setSecret?.("agentic-chat-langfuse-public-key", "");
    app.secretStorage?.setSecret?.("agentic-chat-langfuse-secret-key", "");
    await plugin.saveSettings?.();
  }, OPENAI_COMPATIBLE_KEY_SECRET_ID);
}

async function readSecret(id: string): Promise<string> {
  return await browser.executeObsidian(async ({ app }, secretId) => {
    return (app as unknown as { secretStorage?: { getSecret?: (id: string) => string | null | undefined } }).secretStorage?.getSecret?.(secretId) ?? "";
  }, id);
}

async function readStoredData(): Promise<Record<string, unknown>> {
  return await browser.executeObsidian(async ({ app }) => {
    const raw = await app.vault.adapter.read(`${app.vault.configDir}/plugins/agentic-chat/data.json`);
    return JSON.parse(raw) as Record<string, unknown>;
  });
}

describe("agentic-chat settings UI", function () {
  before(async function () {
    await resetSettingsForUiSpec();
    await openAgenticChatSettings();
  });

  it("persists provider, API key, base URL, and model through the Models tab", async function () {
    await selectSettingsTab("Models");
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
    expect((await readStoredData()).openaiCompatibleApiKey).toBe("");
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

  it("persists a generic MCP server through the MCP tab", async function () {
    await selectSettingsTab("MCP");
    await setSettingToggle("Enable MCP", true);
    await waitForSetting("Servers");
    await clickSettingButton("Servers", "Add server");
    await waitForSetting("HTTPS endpoint");
    await waitForSetting("Setup guide");
    await setSettingText("Name", "Docs MCP E2E");
    await setSettingText("HTTPS endpoint", "https://docs.example.com/mcp");
    await waitForSetting("Authentication");
    await setSettingSelect("Approval", "allow");
    await setSettingSelect("Authentication", "header");
    await waitForSetting("Auth header");
    await setSettingText("Auth header", "X-E2E-Key");
    await setSettingText("Auth value", "mcp-secret");
    await waitForSettingButton("Setup guide", "Copy config");

    await waitForAgenticChatSetting((settings) => {
      const snapshot = settings as unknown as SettingsSnapshot;
      const server = snapshot.mcp.servers[0];
      return (
        snapshot.mcp.enabled &&
        server?.name === "Docs MCP E2E" &&
        server.id === "docs" &&
        server.url === "https://docs.example.com/mcp" &&
        server.enabled &&
        server.approval === "allow" &&
        server.authType === "header" &&
        server.authHeaderName === "X-E2E-Key" &&
        server.authHeaderValue === "mcp-secret"
      );
    }, "MCP settings were not persisted from the settings UI");
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
    const storedObservability = stored.observability as { langfusePublicKey?: string; langfuseSecretKey?: string };
    expect(storedObservability.langfusePublicKey).toBe("");
    expect(storedObservability.langfuseSecretKey).toBe("");
  });

  it("persists resource folders and ignored globs through the Resources tab", async function () {
    await selectSettingsTab("Resources");
    await setSettingText("Skills folder", "Skills");
    await setSettingText("Prompt templates folder (deprecated)", "Templates");
    await setSettingToggle("Built-in subagents", false);
    await setSettingText("Subagents folder", "Agents");
    await setSettingText("Ignore list", "Private/\n*.secret.md");

    const settings = await readAgenticChatSettings<SettingsSnapshot>();
    expect(settings.skillsFolder).toBe("Skills");
    expect(settings.templatesFolder).toBe("Templates");
    expect(settings.enableBuiltinAgents).toBe(false);
    expect(settings.agentsFolder).toBe("Agents");
    expect(settings.ignoredGlobs).toBe("Private/\n*.secret.md");
  });
});
