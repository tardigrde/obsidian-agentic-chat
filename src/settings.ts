import {
  App,
  ButtonComponent,
  Notice,
  Platform,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  ToggleComponent,
  type SettingControl,
  type SettingDefinitionControl,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
  type SettingDefinitionPage,
  type SettingDefinitionRender,
  type SettingGroup,
} from "obsidian";
import type AgenticChatPlugin from "./main";
import { DEFAULT_PLUGINS_FOLDER, resolveMcpServers } from "./plugins/loader";
import type { LoadedPlugin } from "./plugins/loader";
import { createMcpServerState, mcpServerStateFromServer, type McpServerState } from "./mcp/settings";
import { validateMcpUrl } from "./plugins/manifest";
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  listOpenRouterModels,
  type ProviderId,
} from "./llm/models";
import { type ApprovalPolicy, clearMcpPerToolApprovals, setPerToolApproval } from "./agent/approval";
import { type AgentMode, MODE_ORDER, MODES } from "./agent/modes";
import { DEFAULT_SYSTEM_PROMPT } from "./agent/system-prompt";
import { MUTATING_TOOLS } from "./tools/tool-contracts";
import { createVaultTools } from "./tools/vault-tools";
import {
  exportMcpServerConfig,
  mcpServerSetupSteps,
  nextUniqueMcpServerId,
  normalizeMcpServerId,
  resetMcpCredentials,
  resetMcpServerSecretRefs,
  serverIdFromMcpUrl,
  type McpAuthType,
  type McpServerSettings,
} from "./mcp/settings";
import {
  authenticateMcpServer,
  forgetMcpOAuthTokens,
  DEFAULT_MCP_OAUTH_REDIRECT_URI,
  hasMcpOAuthAccess,
  MCP_OAUTH_OBSIDIAN_REDIRECT_URI,
  type McpOAuthProgressEvent,
} from "./mcp/oauth";
import { createFetchFromWebFetcher, createMcpFetcher, createProxiedFetcher } from "./mcp/fetcher";
import { localMcpToolNames, probeMcpServer } from "./mcp/tools";
import {
  formatMcpServerSummary,
  formatMcpToolApprovalDescription,
  formatMcpToolSample,
  mcpAuthProblem,
  mcpCredentialResourceChanged,
  mcpEndpointProblem,
  mcpKnownToolLocalName,
  mcpSecretIds,
  mcpTestButtonState,
} from "./settings-mcp-state";
import { WEB_SEARCH_PROVIDER_LABELS, WEB_SEARCH_PROVIDERS } from "./tools/web-search";
import { FolderSuggestModal } from "./ui/folder-suggest";
import { InstallPluginModal, noticeInstallResult } from "./ui/install-plugin-modal";
import { NewSkillModal } from "./ui/new-skill-modal";
import { ModelSuggestModal } from "./ui/model-suggest-modal";
import { healMcpToolGlobs } from "./mcp/tool-filter";
import {
  type ObservabilityBackend,
  type ObservabilityPayloadMode,
} from "./observability/settings";
import { activeEmbeddingModel, DEFAULT_EMBEDDING_SETTINGS } from "./retrieval/embeddings";

import { effectiveProxy, DEFAULT_PROXY_SETTINGS, PROXY_URL_EXAMPLE } from "./network/proxy";
import { normalizeAllowedHosts } from "./tools/web-allowlist";
import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  PROVIDER_LABELS,
  embeddingModelPlaceholder,
  healSubagentTimeout,
  type AgenticChatSettings,
  type NetworkSettings,
} from "./settings-schema";
import { SETTINGS_TABS, type SettingsSectionId, type SettingsTabId } from "./settings-tabs";
export {
  DEFAULT_SETTINGS,
  PROVIDERS,
  PROVIDER_LABELS,
  THINKING_LEVELS,
  activeModelConfig,
  activeModelId,
  apiKeyForProvider,
  embeddingModelPlaceholder,
  mergeSettings,
} from "./settings-schema";
export type {
  AgenticChatSettings,
  CompactionSettings,
  NetworkSettings,
  NotificationSettings,
  WebSettings,
} from "./settings-schema";
const OBSERVABILITY_BACKEND_LABELS: Record<ObservabilityBackend, string> = {
  langfuse: "Langfuse",
  otlp: "Generic OTLP",
};

/** Text controls always arrive as strings; ignore malformed values from a stale caller. */
function controlText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** First heading of each section, so the declarative group keeps the old visible order. */
const SECTION_HEADINGS: Record<SettingsSectionId, string> = {
  models: "Provider",
  agent: "Agent",
  approval: "Approval gates",
  web: "Web access",
  mcp: "MCP tools",
  observability: "Observability export",
  notifications: "Notifications",
  plugins: "Agent plugins",
  subagents: "Subagents",
  retrieval: "Semantic retrieval",
  "ignored-files": "Ignored files",
};

/** Controls whose value changes the set of rows, so the definitions must be rebuilt. */
const CONTROL_KEYS_THAT_REDRAW = new Set([
  "provider",
  "web.enabled",
  "web.searchProvider",
  "mcp.enabled",
  "observability.enabled",
  "observability.backend",
  "embeddings.provider",
  "plugins.folder",
]);

const OBSERVABILITY_PAYLOAD_LABELS: Record<ObservabilityPayloadMode, string> = {
  metadata: "Metadata only",
  "redacted-previews": "Redacted text previews",
  "full-content": "Full prompt/output content",
};

export interface OpenAICompatiblePreset {
  id: string;
  label: string;
  baseUrl: string;
  modelPlaceholder: string;
  apiKeyPlaceholder: string;
  privacy: "local" | "hosted";
  description: string;
}

export const OPENAI_COMPATIBLE_PRESETS: OpenAICompatiblePreset[] = [
  {
    id: "openwebui",
    label: "OpenWebUI (local/default)",
    baseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    modelPlaceholder: "qwen2.5-coder",
    apiKeyPlaceholder: "sk-...",
    privacy: "local",
    description: "Local gateway; requests stay on the machine or network where OpenWebUI is running.",
  },
  {
    id: "lm-studio",
    label: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    modelPlaceholder: "use the loaded LM Studio model id",
    apiKeyPlaceholder: "lm-studio",
    privacy: "local",
    description: "Local desktop server on LM Studio's default OpenAI-compatible port.",
  },
  {
    id: "vllm",
    label: "vLLM",
    baseUrl: "http://localhost:8000/v1",
    modelPlaceholder: "served-model-name",
    apiKeyPlaceholder: "token-or-empty",
    privacy: "local",
    description: "Self-hosted vLLM OpenAI-compatible server on its default HTTP port.",
  },
  {
    id: "llama-cpp",
    label: "llama.cpp",
    baseUrl: "http://localhost:8080/v1",
    modelPlaceholder: "gpt-3.5-turbo",
    apiKeyPlaceholder: "sk-no-key-required",
    privacy: "local",
    description: "Self-hosted llama.cpp server on its documented OpenAI-compatible base URL.",
  },
  {
    id: "chutes",
    label: "Chutes",
    baseUrl: "https://llm.chutes.ai/v1",
    modelPlaceholder: "deepseek-ai/DeepSeek-V3.1",
    apiKeyPlaceholder: "chutes-...",
    privacy: "hosted",
    description: "Hosted OpenAI-compatible gateway; prompts leave the vault for Chutes and the selected model.",
  },
  {
    id: "venice",
    label: "Venice.ai",
    baseUrl: "https://api.venice.ai/api/v1",
    modelPlaceholder: "zai-org-glm-5-1",
    apiKeyPlaceholder: "venice-...",
    privacy: "hosted",
    description: "Hosted Venice API endpoint; prompts leave the vault for Venice and the selected model.",
  },
];

export function openAICompatiblePresetForBaseUrl(baseUrl: string): OpenAICompatiblePreset | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  return OPENAI_COMPATIBLE_PRESETS.find((preset) => preset.baseUrl.replace(/\/+$/, "") === normalized);
}

export function applyOpenAICompatiblePreset(settings: AgenticChatSettings, presetId: string): boolean {
  const preset = OPENAI_COMPATIBLE_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) return false;
  settings.provider = "openai-compatible";
  settings.openaiCompatibleBaseUrl = preset.baseUrl;
  return true;
}

export class AgenticChatSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: AgenticChatPlugin,
  ) {
    super(app, plugin);
  }

  private async save(): Promise<void> {
    await this.plugin.saveSettings();
  }

  private refresh(): void {
    void this.save().then(() => this.redraw());
  }

  /** Re-evaluate definitions and repaint the open page. 1.13 replacement for display(). */
  private redraw(): void {
    // The vitest Obsidian mock has no SettingTab.update(); guard keeps unit witnesses quiet.
    if (typeof this.update === "function") this.update();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return this.tabs.map((tab) => {
      const page: SettingDefinitionPage & { id: string } = {
        type: "page",
        id: tab.id,
        name: tab.label,
        items: tab.sections.map((section) => this.sectionDefinition(tab.id, section)),
      };
      return page;
    });
  }

  getControlValue(key: string): unknown {
    let value: unknown = this.plugin.settings;
    for (const part of key.split(".")) {
      if (!value || typeof value !== "object") return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    switch (key) {
      case "provider":
        settings.provider = value as ProviderId;
        break;
      case "network.proxyUrl":
        settings.network.proxyUrl = controlText(value).trim();
        break;
      case "network.noProxy":
        settings.network.noProxy = controlText(value).trim();
        break;
      case "mcp.proxyUrl":
        settings.mcp.proxyUrl = controlText(value).trim();
        break;
      case "mcp.noProxy":
        settings.mcp.noProxy = controlText(value).trim();
        break;
      case "observability.endpoint":
        settings.observability.endpoint = controlText(value).trim();
        break;
      case "observability.authHeaderName":
        settings.observability.authHeaderName = controlText(value).trim();
        break;
      case "web.searxngUrl":
        settings.web.searxngUrl = controlText(value).trim();
        break;
      case "openaiCompatibleBaseUrl":
        settings.openaiCompatibleBaseUrl = controlText(value).trim() || DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
        break;
      case "ollamaBaseUrl":
        settings.ollamaBaseUrl = controlText(value).trim() || DEFAULT_OLLAMA_BASE_URL;
        break;
      case "openaiCompatibleModel":
        settings.openaiCompatibleModel = controlText(value).trim();
        break;
      case "ollamaModel":
        settings.ollamaModel = controlText(value).trim();
        break;
      case "systemPrompt":
        settings.systemPrompt = controlText(value).trim() ? String(value) : DEFAULT_SYSTEM_PROMPT;
        break;
      case "plugins.folder":
        settings.plugins.folder = controlText(value).trim();
        this.plugin.pluginService.invalidate();
        this.pluginsLoadedOnce = false;
        break;
      default:
        this.writeControlValue(settings, key, value);
    }
    await this.save();
    if (CONTROL_KEYS_THAT_REDRAW.has(key)) this.redraw();
  }

  private writeControlValue(settings: AgenticChatSettings, key: string, value: unknown): void {
    const parts = key.split(".");
    let target = settings as unknown as Record<string, unknown>;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const next = target[parts[index]];
      if (!next || typeof next !== "object") return;
      target = next as Record<string, unknown>;
    }
    target[parts[parts.length - 1]] = value;
  }

  private sectionDefinition(tabId: SettingsTabId, section: SettingsSectionId): SettingDefinitionGroup {
    const items: SettingDefinitionItem[] = [this.sectionMarker(tabId, section)];
    switch (section) {
      case "models":
        items.push(...this.modelsDefinitions());
        break;
      case "agent":
        items.push(...this.agentDefinitions());
        break;
      case "approval":
        items.push(...this.approvalDefinitions());
        break;
      case "web":
        items.push(...this.webDefinitions());
        break;
      case "mcp":
        items.push(...this.mcpDefinitions());
        break;
      case "observability":
        items.push(...this.observabilityDefinitions());
        break;
      case "notifications":
        items.push(...this.notificationDefinitions());
        break;
      case "plugins":
        items.push(...this.pluginDefinitions());
        break;
      case "subagents":
        items.push(...this.subagentDefinitions());
        break;
      case "retrieval":
        items.push(...this.retrievalDefinitions());
        break;
      case "ignored-files":
        items.push(...this.ignoredFileDefinitions());
        break;
    }
    return {
      type: "group",
      id: section,
      heading: SECTION_HEADINGS[section],
      cls: "agentic-chat-settings-section",
      items,
    } as SettingDefinitionGroup & { id: string };
  }

  /** A declarative row. Use render only when the control needs a side effect a plain control cannot express. */
  private row(
    name: string,
    render: (setting: Setting, group: SettingGroup) => void,
    extra: Omit<SettingDefinitionRender, "name" | "render"> = {},
  ): SettingDefinitionRender {
    return { name, render, ...extra };
  }

  private heading(name: string): SettingDefinitionRender {
    return this.row(name, (setting) => {
      setting.setHeading();
    });
  }

  /** An inline text or warning block that is not a normal setting row. */
  private block(
    render: (setting: Setting) => void,
    options: { name?: string; visible?: boolean | (() => boolean) } = {},
  ): SettingDefinitionRender {
    return {
      name: options.name ?? "",
      searchable: false,
      visible: options.visible,
      render: (setting) => {
        setting.settingEl.empty();
        // A block is a plain container, not a row: nested dynamic rows must not
        // inherit the row padding/border of this wrapper.
        setting.settingEl.removeClass("setting-item");
        setting.settingEl.addClass("agentic-chat-settings-block");
        render(setting);
      },
    };
  }

  private controlDef(
    name: string,
    control: SettingControl,
    desc?: string,
    extra: Omit<SettingDefinitionControl, "name" | "desc" | "control"> = {},
  ): SettingDefinitionControl {
    return { name, desc, control, ...extra };
  }

  /**
   * Render already-built row definitions into a live container. Used by
   * dynamic lists (MCP servers) that must read the current settings on every
   * render instead of freezing the collection at tab-build time.
   */
  private renderItemsInto(containerEl: HTMLElement, items: SettingDefinitionItem[]): void {
    for (const item of items) {
      if ("type" in item) continue;
      const def = item as SettingDefinitionRender;
      const visible = typeof def.visible === "function" ? def.visible() : def.visible;
      if (visible === false) continue;
      const setting = new Setting(containerEl);
      setting.setName(def.name ?? "").setDesc(typeof def.desc === "string" ? def.desc : "");
      if (def.render) def.render(setting, {} as SettingGroup);
    }
  }

  /**
   * Keeps the section/tab DOM handles the e2e helpers and the narrow-width
   * assertions use. The declarative renderer owns the wrappers, so stamp them
   * from the first row of each section instead of rendering a competing tree.
   */
  private sectionMarker(tabId: SettingsTabId, section: SettingsSectionId): SettingDefinitionRender {
    return {
      name: "",
      searchable: false,
      render: (setting) => {
        setting.settingEl.addClass("agentic-chat-settings-section-marker");
        const groupEl = setting.settingEl.closest(".setting-group");
        if (groupEl?.instanceOf(HTMLElement)) groupEl.dataset.settingsSection = section;
        const pageEl = setting.settingEl.closest(".setting-page-content");
        if (pageEl?.instanceOf(HTMLElement)) {
          pageEl.addClass("agentic-chat-settings-tabbody");
          pageEl.dataset.settingsTab = tabId;
        }
      },
    };
  }

  readonly tabs = SETTINGS_TABS;
  private pluginsLoadedOnce = false;
  private pendingMcpServerName = "";
  private pendingMcpServerUrl = "";
  private externallyDeletedPlugins: LoadedPlugin[] = [];
  private externalDeleteCheckRunning = false;
  private lastExternalDeleteCheck = 0;

  /** Trigger an async plugin load once; redraw when it lands so rows appear. */
  private ensurePluginsLoaded(): void {
    if (this.pluginsLoadedOnce && this.plugin.pluginService.hasCache()) {
      // Dot-folders deleted externally don't fire vault.delete; poll the adapter so
      // Resources doesn't show a stale cache until the user clicks Remove.
      const now = Date.now();
      if (this.externalDeleteCheckRunning) return;
      if (now - this.lastExternalDeleteCheck < 2000) return;
      this.externalDeleteCheckRunning = true;
      this.lastExternalDeleteCheck = now;
      void this.plugin.pluginService
        .listExternallyDeletedPlugins()
        .then((deleted) => {
          if (deleted.length > 0) {
            this.externallyDeletedPlugins = deleted;
            // Keep transient until dismissed; auto-prune orphan settings via reload on next display.
            this.pluginsLoadedOnce = false;
            this.ensurePluginsLoaded();
          }
        })
        .catch(() => {})
        .finally(() => {
          this.externalDeleteCheckRunning = false;
        });
      return;
    }
    this.pluginsLoadedOnce = true;
    void this.plugin.pluginService
      .reload()
      .then((plugins) => {
        const mutated = this.reconcileLoadedPlugins(plugins);
        if (mutated) void this.save();
        // Transient prune does not count as settings mutation (reconcile handles split)
        if (this.externallyDeletedPlugins.length > 0) this.redraw();
        return plugins;
      })
      .catch((error: unknown) => {
        console.warn("Agentic chat: could not load agent plugins", error);
      })
      .then(() => this.redraw());
  }

  private reconcileLoadedPlugins(plugins: LoadedPlugin[]): boolean {
    // S10: shape lives in mcp.json; ensure every derived plugin server has a
    // client-owned entry in settings.plugins.mcpState (enabled/approval/auth).
    // No merge into settings.mcp.servers — the two cannot diverge.
    const pluginServers = plugins.flatMap((plugin) => plugin.mcpServers);
    let mutated = false;
    const derivedIds = new Set(pluginServers.map((server) => server.id));
    for (const server of pluginServers) {
      const existing = this.plugin.settings.plugins.mcpState[server.id];
      if (!existing) {
        this.plugin.settings.plugins.mcpState[server.id] = createMcpServerState(server.id, {
          enabled: server.enabled,
          approval: server.approval,
          lastUrl: server.url,
        });
        mutated = true;
      } else if (existing.lastUrl !== server.url) {
        if (existing.lastUrl && existing.lastUrl !== server.url) {
          existing.authHeaderValue = "";
          existing.oauth = { ...existing.oauth, accessToken: "", refreshToken: "", expiresAt: 0 };
          existing.knownTools = [];
          existing.pendingOAuthChallenge = undefined;
          existing.pendingOAuthResourceUrl = undefined;
        }
        existing.lastUrl = server.url;
        mutated = true;
      }
    }
    // A retained import backup still owns the state keys of its package. Keep
    // them until the backup is restored or removed, then prune on a later pass.
    if (!this.plugin.pluginService.hasRetainedImportBackup()) {
      for (const id of Object.keys(this.plugin.settings.plugins.mcpState)) {
        if (!derivedIds.has(id)) {
          const isLegacyUser = this.plugin.settings.mcp.servers.some((entry) => entry.id === id && entry.source !== "plugin");
          if (!isLegacyUser) {
            delete this.plugin.settings.plugins.mcpState[id];
            clearMcpPerToolApprovals(this.plugin.settings.approval, id);
            mutated = true;
          }
        }
      }
    }
    // Prune transient deleted cache entries that have reappeared (recreated outside)
    const alivePaths = new Set(plugins.map((plugin) => plugin.rootPath));
    this.externallyDeletedPlugins = this.externallyDeletedPlugins.filter((plugin) => !alivePaths.has(plugin.rootPath));
    return mutated;
  }

  private mcpDisplayServers(settings: AgenticChatSettings): McpServerSettings[] {
    const pluginServers = this.plugin.pluginService.getLoaded().filter((p) => p.enabled).flatMap((p) => p.mcpServers);
    // Use the same resolution as the runtime (state map primary, legacy mcp.servers fallback for tests/pre-migration).
    return resolveMcpServers(settings, pluginServers);
  }

  private ensureMcpStateEntry(id: string): McpServerState {
    const existing = this.plugin.settings.plugins.mcpState[id];
    if (existing) return existing;
    const created = createMcpServerState(id);
    this.plugin.settings.plugins.mcpState[id] = created;
    return created;
  }

  private syncMcpServerToState(server: McpServerSettings): void {
    if (server.source !== "plugin") return;
    const state = this.ensureMcpStateEntry(server.id);
    const next = mcpServerStateFromServer(server);
    // Preserve secret ids already in state (they are derived from id, but keep if present)
    state.enabled = next.enabled;
    state.approval = next.approval;
    state.authType = next.authType;
    state.authHeaderName = next.authHeaderName;
    state.authHeaderValueSecretId = next.authHeaderValueSecretId;
    state.authHeaderValue = next.authHeaderValue;
    state.oauth = next.oauth;
    state.knownTools = next.knownTools;
    state.enabledTools = [...next.enabledTools];
    state.disabledTools = [...next.disabledTools];
    state.pendingOAuthChallenge = next.pendingOAuthChallenge;
    state.pendingOAuthResourceUrl = next.pendingOAuthResourceUrl;
    if (next.lastUrl) state.lastUrl = next.lastUrl;
    else delete state.lastUrl;
  }

  private modelsDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    const items: SettingDefinitionItem[] = [
      this.controlDef(
        "Model provider",
        {
          type: "dropdown",
          key: "provider",
          options: Object.fromEntries(PROVIDERS.map((provider) => [provider, PROVIDER_LABELS[provider]])),
        },
        "OpenRouter with privacy routing, local Ollama, or any OpenAI-compatible gateway.",
      ),
      this.heading("Network proxy"),
      this.controlDef(
        "HTTP proxy",
        { type: "text", key: "network.proxyUrl", placeholder: PROXY_URL_EXAMPLE },
        "Optional HTTP proxy for plugin-owned network calls: OpenRouter/OpenAI-compatible chat, model browsing, web tools, and MCP unless MCP overrides it.",
      ),
      this.controlDef(
        "No proxy",
        { type: "text", key: "network.noProxy", placeholder: DEFAULT_PROXY_SETTINGS.noProxy },
        "Comma-separated hosts/domains that bypass the plugin proxy.",
      ),
    ];

    if (settings.provider === "openrouter") {
      items.push(...this.openRouterDefinitions(settings));
    } else if (settings.provider === "openai-compatible") {
      items.push(...this.openAICompatibleDefinitions(settings));
    } else {
      items.push(...this.ollamaDefinitions());
    }
    return items;
  }

  private openRouterDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    return [
      this.apiKeyWarning(),
      this.secretInputDef({
        name: "OpenRouter API key",
        desc: "Create one at openrouter.ai/keys.",
        placeholder: "sk-or-...",
        hasValue: () => Boolean(settings.openrouterApiKey),
        onSet: async (value) => {
          settings.openrouterApiKey = value;
          await this.save();
        },
        onForget: async () => {
          settings.openrouterApiKey = "";
          await this.save();
        },
      }),
      this.row("Model", (setting) => {
        setting
          .setDesc('OpenRouter model id. "Browse" lists models that support tool calling.')
          .addText((text) =>
            text
              .setPlaceholder("moonshotai/kimi-k2.6")
              .setValue(settings.openrouterModel)
              .onChange(async (value) => {
                settings.openrouterModel = value.trim();
                await this.save();
              }),
          )
          .addButton((button) =>
            button.setButtonText("Browse").onClick(async () => {
              if (!settings.openrouterApiKey) {
                new Notice("Set your OpenRouter API key first.");
                return;
              }
              button.setDisabled(true);
              try {
                const models = (
                  await listOpenRouterModels(settings.openrouterApiKey, {
                    zdr: settings.privacy.requireZDR,
                    denyDataCollection: settings.privacy.denyDataCollection,
                    fetchImpl: createFetchFromWebFetcher(createProxiedFetcher(settings.network)),
                  })
                )
                  .filter((model) => model.supportsTools)
                  .sort((a, b) => a.id.localeCompare(b.id));
                new ModelSuggestModal(this.app, models, (model) => {
                  settings.openrouterModel = model.id;
                  this.refresh();
                }).open();
              } catch (error) {
                new Notice(`Agentic chat: ${error instanceof Error ? error.message : String(error)}`);
              } finally {
                button.setDisabled(false);
              }
            }),
          );
      }),
      this.heading("Privacy"),
      this.controlDef(
        "Deny prompt logging and training",
        { type: "toggle", key: "privacy.denyDataCollection" },
        'Only route to providers that do not store or train on prompts (data policy "deny").',
      ),
      this.controlDef(
        "Require zero data retention",
        { type: "toggle", key: "privacy.requireZDR" },
        "On by default. Only route to ZDR endpoints; some models may have no compliant provider — pick another model or use Ollama.",
      ),
      this.controlDef(
        "Allow provider fallbacks",
        { type: "toggle", key: "privacy.allowFallbacks" },
        "Let OpenRouter fall back to other still-compliant providers when the preferred one is down.",
      ),
    ];
  }

  private ollamaDefinitions(): SettingDefinitionItem[] {
    return [
      this.controlDef(
        "Ollama server URL",
        { type: "text", key: "ollamaBaseUrl", placeholder: DEFAULT_OLLAMA_BASE_URL },
        "Base URL of your local Ollama server. The OpenAI-compatible endpoint is derived as <url>/v1.",
      ),
      this.controlDef(
        "Model",
        { type: "text", key: "ollamaModel", placeholder: "llama3.1" },
        "An installed Ollama model tag, e.g. llama3.1 or qwen2.5-coder.",
      ),
    ];
  }

  private openAICompatibleDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    const activePreset = openAICompatiblePresetForBaseUrl(settings.openaiCompatibleBaseUrl);
    return [
      this.apiKeyWarning(),
      this.row("Gateway preset", (setting) => {
        setting
          .setDesc(
            activePreset
              ? activePreset.description
              : "Optional shortcut for common OpenAI-compatible gateways. Choose one to fill the Base URL; edit fields below for custom gateways.",
          )
          .addDropdown((dropdown) => {
            dropdown.addOption("", "Custom");
            for (const preset of OPENAI_COMPATIBLE_PRESETS) {
              dropdown.addOption(preset.id, preset.label);
            }
            dropdown.setValue(activePreset?.id ?? "").onChange(async (value) => {
              if (!value) return;
              applyOpenAICompatiblePreset(settings, value);
              await this.save();
              this.redraw();
            });
          });
      }),
      this.controlDef(
        "Base URL",
        {
          type: "text",
          key: "openaiCompatibleBaseUrl",
          placeholder: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
        },
        "Base URL for an OpenAI chat-completions compatible gateway. Bare OpenWebUI roots are resolved to /api.",
      ),
      this.secretInputDef({
        name: "API key",
        desc: "Bearer token for the configured OpenAI-compatible gateway.",
        placeholder: activePreset?.apiKeyPlaceholder ?? "sk-...",
        hasValue: () => Boolean(settings.openaiCompatibleApiKey),
        onSet: async (value) => {
          settings.openaiCompatibleApiKey = value;
          await this.save();
        },
        onForget: async () => {
          settings.openaiCompatibleApiKey = "";
          await this.save();
        },
      }),
      this.controlDef(
        "Model",
        {
          type: "text",
          key: "openaiCompatibleModel",
          placeholder: activePreset?.modelPlaceholder ?? "qwen2.5-coder",
        },
        "Model id exposed by the configured gateway.",
      ),
      this.row("Context window (tokens)", (setting) => {
        setting
          .setDesc(
            "Optional. 0 auto-detects from the OpenRouter catalog for the same model slug (best effort) and keeps every " +
              "tool when unknown. Set the real value (e.g. 128000) if your gateway exposes a different window than " +
              "OpenRouter; this drives the tool budget and auto-compaction.",
          )
          .addText((text) =>
            text
              .setPlaceholder("0 = auto-detect")
              .setValue(settings.openaiCompatibleContextWindow > 0 ? String(settings.openaiCompatibleContextWindow) : "")
              .onChange(async (value) => {
                const parsed = Number.parseInt(value, 10);
                settings.openaiCompatibleContextWindow = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
                await this.save();
              }),
          );
      }),
    ];
  }

  private agentDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    return [
      this.row("Permission mode", (setting) => {
        setting
          .setDesc(
            "Safe honors your approval gates; YOLO auto-approves every mutating tool for the session " +
              "(a per-tool deny still wins). The settings dropdown and the composer toggle share one setting and stay in sync.",
          )
          .addDropdown((dropdown) => {
            // S4: single list, same labels as MODES — every surface reflects the same source (Codex atomic override).
            for (const id of MODE_ORDER) dropdown.addOption(id, MODES[id].label);
            dropdown.setValue(settings.mode).onChange(async (value) => {
              const target = value as AgentMode;
              await this.plugin.requestModeChange(target);
              // Re-sync the dropdown to the actual persisted value (blocked transitions leave it unchanged; Notice is shown by requestModeChange).
              dropdown.setValue(this.plugin.settings.mode);
            });
          });
      }),
      this.controlDef("Temperature", { type: "slider", key: "temperature", min: 0, max: 2, step: 0.1 }),
      this.controlDef(
        "Max response tokens",
        { type: "number", key: "maxTokens", min: 0 },
        "Per model request. 0 lets the provider decide.",
      ),
      this.row("Request timeout (seconds)", (setting) => {
        setting
          .setDesc("How long to wait for the provider to start responding.")
          .addText((text) =>
            text.setValue(String(Math.round(settings.requestTimeoutMs / 1000))).onChange(async (value) => {
              const parsed = Number.parseInt(value, 10);
              settings.requestTimeoutMs =
                Number.isFinite(parsed) && parsed >= 5 ? parsed * 1000 : DEFAULT_SETTINGS.requestTimeoutMs;
              await this.save();
            }),
          );
      }),
      this.controlDef(
        "Network retries",
        { type: "slider", key: "maxNetworkRetries", min: 0, max: 5, step: 1 },
        "Automatic retries on rate limits and transient server errors.",
      ),
      this.row("System prompt", (setting) => {
        setting
          .setDesc("Sent at the start of every conversation.")
          .addTextArea((text) => {
            text.inputEl.rows = 10;
            text.inputEl.addClass("agentic-chat-system-prompt");
            text.setValue(settings.systemPrompt).onChange(async (value) => {
              settings.systemPrompt = value.trim() ? value : DEFAULT_SYSTEM_PROMPT;
              await this.save();
            });
          });
      }),
      {
        name: "Standing instructions",
        desc:
          "The agent loads AGENTS.md from the vault root every turn as standing context " +
          "(falls back to CLAUDE.md, then GEMINI.md, if AGENTS.md is absent — symlink them for other agents). " +
          "Edit the file directly, or run /init to have the agent curate it.",
      },
      this.heading("Context window"),
      this.controlDef(
        "Auto-compaction",
        { type: "toggle", key: "compaction.enabled" },
        "Summarize older turns automatically as the context window fills, so long conversations don't hit the " +
          "model limit or spike cost. The summary replaces the compacted turns in the transcript.",
      ),
      this.controlDef(
        "Compact at (% of context window)",
        { type: "slider", key: "compaction.thresholdPercent", min: 50, max: 95, step: 5 },
        "Trigger compaction once the conversation fills this share of the model's context window.",
      ),
      this.heading("Tool budget"),
      this.controlDef(
        "Drop optional tools when schemas are large",
        { type: "toggle", key: "toolBudget.enabled" },
        "When registered tool schemas alone exceed the threshold, hide optional expansion tools such as web, MCP, artifacts, PDF import, and subagents.",
      ),
      this.controlDef(
        "Drop tools when schemas exceed (% of context window)",
        { type: "slider", key: "toolBudget.thresholdPercent", min: 1, max: 50, step: 1 },
        "Low by default so large tool catalogs shed optional tools before tool schemas become expensive.",
      ),
    ];
  }

  private approvalDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    const items: SettingDefinitionItem[] = [
      this.controlDef(
        "Before mutating tools",
        {
          type: "dropdown",
          key: "approval.mutating",
          options: { allow: "Allow automatically", ask: "Ask each time", deny: "Deny (read-only mode)" },
        },
        "Gate tools that change the vault. Read-only tools always run. 'Ask' shows a confirm dialog.",
      ),
    ];

    items.push(
      this.row("Per-tool overrides", (setting) => {
        setting
          .setDesc(
            "Override allow/ask/deny for individual tools. 'Default' follows the rule above (read-only tools always run).",
          )
          .setHeading();
      }),
    );
    for (const tool of createVaultTools(this.app)) {
      const mutating = MUTATING_TOOLS.has(tool.name);
      items.push(
        this.row(tool.label, (setting) => {
          setting.setDesc(`${tool.name} · ${mutating ? "mutating" : "read-only"}`).addDropdown((dropdown) => {
            dropdown
              .addOption("default", "Default")
              .addOption("allow", "Allow")
              .addOption("ask", "Ask")
              .addOption("deny", "Deny")
              .setValue(settings.approval.perTool[tool.name] ?? "default")
              .onChange(async (value) => {
                setPerToolApproval(settings.approval, tool.name, value as ApprovalPolicy | "default");
                await this.save();
              });
          });
        }),
      );
    }
    return items;
  }

  private webDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    const items: SettingDefinitionItem[] = [
      this.warning(
        "⚠",
        "Web search and fetch send your query text and the URLs the agent opens to a third-party " +
          "service, off-device — outside the vault's privacy boundary. Off by default; turn it on only " +
          "when you want the agent to use the open web.",
      ),
      this.controlDef(
        "Enable web search & fetch",
        { type: "toggle", key: "web.enabled" },
        "Give the agent web_search and fetch_url tools. When off, the agent cannot reach the network at all.",
      ),
    ];

    if (!settings.web.enabled) return items;

    items.push(
      this.controlDef(
        "Search provider",
        {
          type: "dropdown",
          key: "web.searchProvider",
          options: Object.fromEntries(WEB_SEARCH_PROVIDERS.map((provider) => [provider, WEB_SEARCH_PROVIDER_LABELS[provider]])),
        },
        "Backend for web_search. Tavily and Brave need an API key; SearXNG needs a self-hosted instance URL.",
      ),
    );

    if (settings.web.searchProvider === "searxng") {
      items.push(
        this.controlDef(
          "SearXNG instance URL",
          { type: "text", key: "web.searxngUrl", placeholder: "https://searx.example.com" },
          "Base URL of your SearXNG instance, e.g. https://searx.example.com. The JSON API must be enabled.",
        ),
      );
    } else {
      items.push(
        this.secretInputDef({
          name: "Search API key",
          desc:
            settings.web.searchProvider === "tavily"
              ? "Tavily API key (tavily.com)."
              : "Brave Search API key (brave.com/search/api).",
          placeholder: settings.web.searchProvider === "tavily" ? "tvly-..." : "BSA...",
          hasValue: () => Boolean(settings.web.searchApiKey),
          onSet: async (value) => {
            settings.web.searchApiKey = value;
            await this.save();
          },
          onForget: async () => {
            settings.web.searchApiKey = "";
            await this.save();
          },
        }),
      );
    }

    items.push(
      this.controlDef(
        "Search results",
        { type: "slider", key: "web.maxResults", min: 1, max: 10, step: 1 },
        "How many results web_search returns by default.",
      ),
      this.row("Fetched page character limit", (setting) => {
        setting
          .setDesc("Maximum characters of a fetched page's text returned to the model.")
          .addText((text) => {
            text.inputEl.type = "number";
            text.inputEl.setAttribute("min", "500");
            text.setValue(String(settings.web.fetchCharLimit)).onChange(async (value) => {
              const parsed = Number.parseInt(value, 10);
              settings.web.fetchCharLimit =
                Number.isFinite(parsed) && parsed >= 500 ? parsed : DEFAULT_SETTINGS.web.fetchCharLimit;
              await this.save();
            });
          });
      }),
      this.row("Allowed hosts", (setting) => {
        setting
          .setDesc(
            "Optional comma-separated host suffixes for fetch_url. Empty allows any public host. " +
              'Example: example.com, *.wikipedia.org — blocks other hosts with "Blocked by allowlist".',
          )
          .addText((text) =>
            text
              .setPlaceholder("example.com, *.wikipedia.org")
              .setValue(settings.web.allowedHosts)
              .onChange(async (value) => {
                settings.web.allowedHosts = normalizeAllowedHosts(value);
                await this.save();
                // Update the field to the canonical (lower-cased, deduped) value so typos like `Example.COM` are visible immediately.
                text.setValue(settings.web.allowedHosts);
              }),
          );
      }),
    );
    return items;
  }

  private mcpDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    const enabled = () => settings.mcp.enabled;
    return [
      this.warning(
        "⚠",
        "MCP tools send tool names and arguments to configured remote MCP servers. Only HTTPS " +
          "Streamable HTTP endpoints are supported; stdio and subprocess servers are intentionally unsupported.",
      ),
      this.controlDef(
        "Enable MCP",
        { type: "toggle", key: "mcp.enabled" },
        "Discover and register tools from configured HTTPS MCP servers.",
      ),
      this.controlDef(
        "HTTP proxy",
        { type: "text", key: "mcp.proxyUrl", placeholder: PROXY_URL_EXAMPLE },
        "Optional MCP-only override. Leave empty to inherit the global network proxy from the Models tab.",
        { visible: enabled },
      ),
      this.controlDef(
        "No proxy",
        { type: "text", key: "mcp.noProxy", placeholder: DEFAULT_PROXY_SETTINGS.noProxy },
        "Comma-separated hosts/domains that bypass the MCP proxy.",
        { visible: enabled },
      ),
      this.block(
        (setting) => {
          const heading = setting.settingEl.createDiv({ cls: "agentic-chat-mcp-heading" });
          heading.createDiv({ text: "Add MCP server", cls: "agentic-chat-mcp-heading-title" });
          heading.createDiv({
            text:
              "Writes a real agent plugin package (plugin.json + mcp.json) into the plugins folder. " +
              "Packages, not settings, own server endpoints after creation.",
            cls: "setting-item-description",
          });
        },
        { name: "Add MCP server", visible: enabled },
      ),
      this.row(
        "",
        (setting) => {
          setting
            .setClass("agentic-chat-mcp-add")
            .addText((text) =>
              text
                .setPlaceholder("Server name")
                .setValue(this.pendingMcpServerName)
                .onChange((value) => {
                  this.pendingMcpServerName = value;
                }),
            )
            .addText((text) =>
              text
                .setPlaceholder("https://mcp.example.com/mcp")
                .setValue(this.pendingMcpServerUrl)
                .onChange((value) => {
                  this.pendingMcpServerUrl = value;
                }),
            )
            .addButton((button) =>
              button.setButtonText("Add MCP server").onClick(async () => {
                const url = this.pendingMcpServerUrl.trim();
                const name = this.pendingMcpServerName.trim();
                if (!name || !url) {
                  new Notice("Agentic Chat MCP: enter a server name and an HTTPS (or loopback HTTP) endpoint.");
                  return;
                }
                try {
                  if (validateMcpUrl(url) !== null) throw new Error("only HTTPS (or loopback HTTP) endpoints are supported");
                  // Package creation can fail mid-write (stale file tree, an
                  // externally synced folder of the same name, interrupted writes);
                  // surface it instead of dropping the rejection on the floor.
                  const result = await this.plugin.pluginService.generateMcpServerPackage({ serverName: name, url });
                  this.pendingMcpServerName = "";
                  this.pendingMcpServerUrl = "";
                  // The package is new; drop the once-only load guard so the next
                  // redraw picks it up from the vault.
                  this.pluginsLoadedOnce = false;
                  new Notice(`Agentic Chat MCP: created plugin package at ${result.rootPath}.`);
                  this.redraw();
                } catch (error) {
                  new Notice(`Agentic Chat MCP: ${error instanceof Error ? error.message : String(error)}`);
                }
              }),
            );
        },
        { visible: enabled },
      ),
      this.block(
        (setting) => {
          // Read the collection at render time: packages and legacy user rows
          // can change while the settings modal stays open.
          this.ensurePluginsLoaded();
          const displayServers = this.mcpDisplayServers(settings);
          if (displayServers.length === 0) {
            setting.settingEl.createDiv({
              cls: "setting-item-description",
              text: "No MCP servers. Generate a plugin package above, or add a plugin folder with an mcp.json inside the plugin folder.",
            });
            return;
          }
          this.renderItemsInto(
            setting.settingEl,
            displayServers.flatMap((server) => this.mcpServerDefinitions(settings, server)),
          );
        },
        { name: "MCP servers", visible: enabled },
      ),
    ];
  }

  private observabilityDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    const items: SettingDefinitionItem[] = [
      this.warning(
        "i",
        "Observability is opt-in and has no built-in endpoint. When enabled, Agentic Chat exports " +
          "turn, model, tool, approval, token, and cost metadata to the endpoint you configure. Prompt " +
          "and answer text is withheld unless you explicitly change payload detail below.",
      ),
      this.controlDef(
        "Enable observability",
        { type: "toggle", key: "observability.enabled" },
        "Export OTLP/HTTP traces for agent turns. Leave off for the default no-telemetry behavior.",
      ),
    ];

    if (!settings.observability.enabled) return items;

    items.push(
      this.controlDef(
        "Backend",
        {
          type: "dropdown",
          key: "observability.backend",
          options: Object.fromEntries(
            (Object.keys(OBSERVABILITY_BACKEND_LABELS) as ObservabilityBackend[]).map((backend) => [
              backend,
              OBSERVABILITY_BACKEND_LABELS[backend],
            ]),
          ),
        },
        "Langfuse configures OTLP headers for Langfuse ingestion; generic OTLP accepts a direct /v1/traces endpoint.",
      ),
      this.controlDef(
        settings.observability.backend === "langfuse" ? "Langfuse base URL" : "OTLP traces endpoint",
        {
          type: "text",
          key: "observability.endpoint",
          placeholder:
            settings.observability.backend === "langfuse"
              ? "https://langfuse.example.com"
              : "https://otel.example.com/v1/traces",
        },
        settings.observability.backend === "langfuse"
          ? "Corporate/self-hosted Langfuse base URL. The plugin posts to /api/public/otel/v1/traces."
          : "Full OTLP HTTP/JSON traces endpoint, usually ending in /v1/traces.",
      ),
      this.controlDef(
        "Payload detail",
        {
          type: "dropdown",
          key: "observability.payloadMode",
          options: Object.fromEntries(
            (Object.keys(OBSERVABILITY_PAYLOAD_LABELS) as ObservabilityPayloadMode[]).map((mode) => [
              mode,
              OBSERVABILITY_PAYLOAD_LABELS[mode],
            ]),
          ),
        },
        "Metadata only sends timings, model ids, token/cost totals, tool names, approvals, and errors. " +
          "Text modes send prompt/answer text to the configured backend.",
      ),
      this.controlDef(
        "Sample rate",
        { type: "slider", key: "observability.sampleRate", min: 0, max: 100, step: 1 },
        "Percentage of agent turns to export.",
      ),
      this.controlDef(
        "HTTP proxy",
        { type: "text", key: "observability.proxyUrl", placeholder: PROXY_URL_EXAMPLE },
        "Optional observability-only override. Leave empty to inherit the global network proxy from the Models tab.",
      ),
      this.controlDef(
        "No proxy",
        { type: "text", key: "observability.noProxy", placeholder: DEFAULT_PROXY_SETTINGS.noProxy },
        "Comma-separated hosts/domains that bypass the observability proxy.",
      ),
    );

    if (settings.observability.backend === "langfuse") {
      items.push(
        this.secretInputDef({
          name: "Langfuse public key",
          desc: "Public key for the configured Langfuse project.",
          placeholder: "pk-lf-...",
          hasValue: () => Boolean(settings.observability.langfusePublicKey),
          onSet: async (value) => {
            settings.observability.langfusePublicKey = value;
            await this.save();
          },
          onForget: async () => {
            settings.observability.langfusePublicKey = "";
            await this.save();
          },
        }),
        this.secretInputDef({
          name: "Langfuse secret key",
          desc: "Secret key for the configured Langfuse project.",
          placeholder: "sk-lf-...",
          hasValue: () => Boolean(settings.observability.langfuseSecretKey),
          onSet: async (value) => {
            settings.observability.langfuseSecretKey = value;
            await this.save();
          },
          onForget: async () => {
            settings.observability.langfuseSecretKey = "";
            await this.save();
          },
        }),
      );
      return items;
    }

    items.push(
      this.controlDef(
        "Auth header name",
        { type: "text", key: "observability.authHeaderName", placeholder: "Authorization" },
        "Optional header name for a generic OTLP backend, e.g. Authorization.",
      ),
      this.secretInputDef({
        name: "Auth header value",
        desc: "Optional header value for the generic OTLP backend.",
        placeholder: "Bearer ...",
        hasValue: () => Boolean(settings.observability.authHeaderValue),
        onSet: async (value) => {
          settings.observability.authHeaderValue = value;
          await this.save();
        },
        onForget: async () => {
          settings.observability.authHeaderValue = "";
          await this.save();
        },
      }),
    );
    return items;
  }

  private mcpServerDefinitions(
    settings: AgenticChatSettings,
    server: McpServerSettings,
  ): SettingDefinitionItem[] {
    const pluginManaged = server.source === "plugin";
    const items: SettingDefinitionItem[] = [];

    items.push(
      this.row(server.name || server.id, (setting) => {
        const endpointProblem = mcpEndpointProblem(server.url);
        setting
          .setName(server.name || server.id)
          .setDesc(
            formatMcpServerSummary(server, endpointProblem) + (pluginManaged ? ` (managed by ${server.pluginRoot})` : ""),
          )
          .setClass("agentic-chat-mcp-server-header")
          .setClass("agentic-chat-setting-heading-wrap")
          .setHeading();
        let testButton: ButtonComponent | undefined;
        const syncTestButton = (): void => {
          if (!testButton) return;
          const state = mcpTestButtonState(server);
          testButton.setButtonText(state.label).setDisabled(Boolean(state.problem));
        };
        setting.addToggle((toggle) =>
          toggle.setValue(server.enabled).onChange(async (value) => {
            server.enabled = value;
            this.syncMcpServerToState(server);
            await this.save();
          }),
        );
        setting.addButton((button) => {
          testButton = button;
          syncTestButton();
          return button.onClick(async () => {
            const state = mcpTestButtonState(server);
            if (state.problem) {
              new Notice(state.problem);
              syncTestButton();
              return;
            }
            await this.runMcpButtonAction(
              button,
              state.label,
              state.busyLabel,
              () => (state.needsOAuthSignIn ? this.authenticateAndProbeMcpServer(server) : this.testMcpServer(server)),
            );
            syncTestButton();
          });
        });

        if (server.authType === "oauth") {
          setting.addButton((button) =>
            button
              .setButtonText("Re-authenticate")
              .setDisabled(Boolean(endpointProblem))
              .onClick(async () => {
                if (endpointProblem) {
                  new Notice(endpointProblem);
                  return;
                }
                await this.runMcpButtonAction(button, "Re-authenticate", "Authenticating...", () =>
                  this.authenticateAndProbeMcpServer(server),
                );
              }),
          );
        }

        setting.addButton((button) =>
          button
            .setButtonText("Remove")
            .setClass("mod-warning")
            .setDisabled(pluginManaged)
            .onClick(async () => {
              this.deleteMcpPerToolApprovals(settings, server.id);
              this.clearMcpSecretSlots(server);
              settings.mcp.servers = settings.mcp.servers.filter((entry) => entry !== server);
              await this.save();
              this.redraw();
            }),
        );
      }),
    );

    // Show banner when server advertised OAuth via 401 but authType is still none/bearer/header
    if (server.pendingOAuthChallenge && server.pendingOAuthResourceUrl) {
      items.push(
        this.block((setting) => {
          const banner = setting.settingEl.createDiv({ cls: "setting-item-description agentic-chat-oauth-banner" });
          const isNone = server.authType === "none";
          banner.createSpan({
            text: isNone
              ? `This server requires OAuth (resource: ${server.pendingOAuthResourceUrl}). Click Authenticate & test to sign in — no need to change the Authentication dropdown manually.`
              : `This server advertises OAuth (resource: ${server.pendingOAuthResourceUrl}) but is set to ${server.authType}. `,
          });
          if (!isNone) {
            const switchBtn = banner.createEl("button", { text: "Switch to OAuth", cls: "mod-cta" });
            switchBtn.addEventListener("click", () => {
              void (async () => {
                server.authType = "oauth";
                server.pendingOAuthChallenge = undefined;
                server.pendingOAuthResourceUrl = undefined;
                this.syncMcpServerToState(server);
                await this.save();
                this.redraw();
              })();
            });
          }
        }),
      );
    }

    if (pluginManaged) {
      items.push(
        this.block((setting) => {
          setting.settingEl.createDiv({
            cls: "setting-item-description",
            text:
              `This server lives in the "${server.pluginRoot}" agent plugin package. ` +
              "Its endpoint and literal headers come from mcp.json; authentication is configured client-side " +
              "and stays with this plugin. Remove the package folder to delete the server.",
          });
        }),
      );
    }

    items.push(
      this.row("Name", (setting) => {
        setting.setDesc("Shown in tool labels and approval prompts.").addText((text) =>
          text
            .setDisabled(pluginManaged)
            .setValue(server.name)
            .onChange(async (value) => {
              server.name = value.trim() || server.id;
              await this.save();
            }),
        );
      }),
      this.row("Server id", (setting) => {
        setting.setDesc("Advanced. Used in local tool names: mcp__<id>__<tool>.").addText((text) =>
          text
            .setDisabled(pluginManaged)
            .setValue(server.id)
            .onChange(async (value) => {
              const next = normalizeMcpServerId(value);
              this.renameMcpServer(settings, server, this.nextMcpServerId(settings, next, server));
              await this.save();
            }),
        );
      }),
      this.row("HTTPS endpoint", (setting) => {
        const endpointProblem = mcpEndpointProblem(server.url);
        setting
          .setDesc(endpointProblem || "Streamable HTTP endpoint. Query parameters are preserved. Loopback hosts may use http://.")
          .addText((text) =>
            text
              .setDisabled(pluginManaged)
              .setPlaceholder("https://mcp.example.com/mcp")
              .setValue(server.url)
              .onChange(async (value) => {
                const result = this.updateMcpServerEndpoint(settings, server, value);
                await this.save();
                if (result.clearedCredentials) new Notice(`${server.name}: cleared MCP credentials for the changed endpoint.`);
                if (result.shouldDisplay) this.redraw();
              }),
          );
      }),
      this.row("Approval", (setting) => {
        setting.setDesc("Gate every tool call from this server.").addDropdown((dropdown) =>
          dropdown
            .addOption("ask", "Ask each time")
            .addOption("allow", "Allow automatically")
            .addOption("deny", "Deny")
            .setValue(server.approval)
            .onChange(async (value) => {
              server.approval = value as ApprovalPolicy;
              this.syncMcpServerToState(server);
              await this.save();
            }),
        );
      }),
      this.row("Setup guide", (setting) => {
        const description = mcpServerSetupSteps(server)
          .map((step) => `${step.label}: ${step.status === "complete" ? "done" : step.status} - ${step.message}`)
          .join(" ");
        setting.setDesc(description).addButton((button) =>
          button.setButtonText("Copy config").onClick(async () => {
            const copied = await this.copyToClipboard(JSON.stringify(exportMcpServerConfig(server), null, 2));
            new Notice(copied ? `${server.name}: MCP config copied without secrets.` : `${server.name}: could not copy MCP config.`);
          }),
        );
      }),
    );

    items.push(...this.mcpAuthenticationDefinitions(server));
    items.push(...this.mcpToolFilterDefinitions(server));
    items.push(...this.mcpToolApprovalDefinitions(settings, server));
    return items;
  }

  private mcpToolFilterDefinitions(server: McpServerSettings): SettingDefinitionItem[] {
    return [
      this.heading("Tool filtering"),
      this.block((setting) => {
        setting.settingEl.createDiv({
          cls: "setting-item-description",
          text:
            "Ordered allow-then-deny globs for this server's native tool names (the names the MCP server " +
            "reports, not the local mcp__ names shown below). Same dialect as vault ignore: * / ** / ?. " +
            "Enabled is an allowlist (empty = allow all); disabled is a denylist (deny wins). " +
            "Up to 100 patterns, 200 characters each. Examples: * · read_* · *?_danger · tool_*",
        });
      }),
      this.row("Enabled tools (allowlist)", (setting) => {
        setting
          .setDesc("One glob per line. When non-empty, only tools matching at least one pattern are exposed. Empty allows all.")
          .addTextArea((text) => {
            text.inputEl.rows = 3;
            text.inputEl.addClass("agentic-chat-system-prompt");
            text
              .setPlaceholder("*\nread_*\n*_safe")
              .setValue((server.enabledTools ?? []).join("\n"))
              .onChange(async (value) => {
                const patterns = healMcpToolGlobs(
                  value
                    .split(/\r?\n/)
                    .map((line) => line.normalize("NFC").trim())
                    .filter((line) => line.length > 0 && !line.startsWith("#")),
                );
                server.enabledTools = patterns;
                this.syncMcpServerToState(server);
                await this.save();
              });
          });
      }),
      this.row("Disabled tools (denylist)", (setting) => {
        setting
          .setDesc("One glob per line. Any tool matching a disabled pattern is hidden even if it matched the allowlist.")
          .addTextArea((text) => {
            text.inputEl.rows = 3;
            text.inputEl.addClass("agentic-chat-system-prompt");
            text
              .setPlaceholder("*_danger\nwrite_*\nsecret_*")
              .setValue((server.disabledTools ?? []).join("\n"))
              .onChange(async (value) => {
                const patterns = healMcpToolGlobs(
                  value
                    .split(/\r?\n/)
                    .map((line) => line.normalize("NFC").trim())
                    .filter((line) => line.length > 0 && !line.startsWith("#")),
                );
                server.disabledTools = patterns;
                this.syncMcpServerToState(server);
                await this.save();
              });
          });
      }),
    ];
  }

  private mcpToolApprovalDefinitions(
    settings: AgenticChatSettings,
    server: McpServerSettings,
  ): SettingDefinitionItem[] {
    const items: SettingDefinitionItem[] = [
      this.row("Tool approvals", (setting) => {
        setting
          .setDesc("Per-tool overrides for the last discovered tools. Default follows this server's approval policy.")
          .setClass("agentic-chat-setting-heading-wrap")
          .setHeading()
          .addButton((button) =>
            button.setButtonText("Refresh tools").onClick(async () => {
              await this.refreshMcpKnownTools(server, button);
            }),
          );
      }),
    ];

    if (server.knownTools.length === 0) {
      items.push(
        this.block((setting) => {
          setting.settingEl.createDiv({
            cls: "setting-item-description",
            text: "No discovered tools cached yet. Use Refresh tools, Test connection, or Authenticate & test.",
          });
        }),
      );
      return items;
    }

    for (const tool of [...server.knownTools].sort((a, b) => a.name.localeCompare(b.name))) {
      const localName = mcpKnownToolLocalName(server, tool);
      const title = tool.title && tool.title !== tool.name ? `${tool.title} (${tool.name})` : tool.name;
      items.push(
        this.row(title, (setting) => {
          setting.setDesc(formatMcpToolApprovalDescription(localName, tool)).addDropdown((dropdown) =>
            dropdown
              .addOption("default", `Default (${server.approval})`)
              .addOption("allow", "Allow")
              .addOption("ask", "Ask")
              .addOption("deny", "Deny")
              .setValue(settings.approval.perTool[localName] ?? "default")
              .onChange(async (value) => {
                setPerToolApproval(settings.approval, localName, value as ApprovalPolicy | "default");
                await this.save();
              }),
          );
        }),
      );
    }
    return items;
  }

  private mcpAuthenticationDefinitions(server: McpServerSettings): SettingDefinitionItem[] {
    const authProblem = mcpAuthProblem(server);
    const items: SettingDefinitionItem[] = [
      this.row("Authentication", (setting) => {
        setting
          .setDesc(authProblem || "Choose how this server authenticates. Secrets are stored in Obsidian secret storage.")
          .addDropdown((dropdown) =>
            dropdown
              .addOption("none", "None")
              .addOption("bearer", "Bearer token")
              .addOption("header", "Static header")
              .addOption("oauth", "OAuth")
              .setValue(server.authType)
              .onChange(async (value) => {
                server.authType = value as McpAuthType;
                if (server.authType === "bearer") server.authHeaderName = "";
                this.syncMcpServerToState(server);
                await this.save();
                this.redraw();
              }),
          );
      }),
    ];

    if (server.authType === "oauth") {
      items.push(...this.mcpOAuthDefinitions(server));
      return items;
    }

    if (server.authType === "bearer") {
      items.push(
        this.secretInputDef({
          name: "Bearer token",
          desc: 'Paste the token only. If you include "Bearer", Agentic Chat will not add it twice.',
          placeholder: "token",
          hasValue: () => Boolean(server.authHeaderValue),
          onSet: async (value) => {
            server.authHeaderValue = value;
            this.syncMcpServerToState(server);
            await this.save();
            this.redraw();
          },
          onForget: async () => {
            server.authHeaderValue = "";
            this.syncMcpServerToState(server);
            await this.save();
          },
        }),
      );
      return items;
    }

    if (server.authType !== "header") return items;

    items.push(
      this.row("Auth header", (setting) => {
        setting.setDesc("Header name sent with every MCP request.").addText((text) =>
          text
            .setPlaceholder("X-API-Key")
            .setValue(server.authHeaderName)
            .onChange(async (value) => {
              server.authHeaderName = value.trim();
              this.syncMcpServerToState(server);
              await this.save();
              this.redraw();
            }),
        );
      }),
      this.secretInputDef({
        name: "Auth value",
        desc: "Header value sent with every MCP request.",
        placeholder: "secret header value",
        hasValue: () => Boolean(server.authHeaderValue),
        onSet: async (value) => {
          server.authHeaderValue = value;
          this.syncMcpServerToState(server);
          await this.save();
          this.redraw();
        },
        onForget: async () => {
          server.authHeaderValue = "";
          this.syncMcpServerToState(server);
          await this.save();
        },
      }),
    );
    return items;
  }

  private mcpOAuthDefinitions(server: McpServerSettings): SettingDefinitionItem[] {
    const authenticated = hasMcpOAuthAccess(server);
    const scopePart = server.oauth.scope ? ` with scopes: ${server.oauth.scope}` : "";
    return [
      this.row("OAuth status", (setting) => {
        setting
          .setDesc(
            authenticated
              ? `Authenticated${scopePart}.`
              : "Not authenticated. Use the Authenticate & test button in this server's header.",
          )
          .addButton((button) =>
            button
              .setButtonText("Forget token")
              .setDisabled(!server.oauth.accessToken && !server.oauth.refreshToken)
              .onClick(async () => {
                forgetMcpOAuthTokens(server);
                server.knownTools = [];
                this.syncMcpServerToState(server);
                await this.save();
                this.redraw();
              }),
          );
      }),
      this.row("OAuth desktop redirect URI", (setting) => {
        setting
          .setDesc("Register this localhost URI with MCP OAuth servers for Obsidian desktop sign-in.")
          .addText((text) => text.setValue(DEFAULT_MCP_OAUTH_REDIRECT_URI).setDisabled(true))
          .addButton((button) =>
            button.setButtonText("Copy").onClick(async () => {
              if (await this.copyToClipboard(DEFAULT_MCP_OAUTH_REDIRECT_URI)) {
                new Notice("MCP OAuth redirect URI copied.");
              } else {
                new Notice(`MCP OAuth redirect URI: ${DEFAULT_MCP_OAUTH_REDIRECT_URI}`);
              }
            }),
          );
      }),
      this.row("OAuth mobile redirect URI", (setting) => {
        setting
          .setDesc("Register this Obsidian URI as an additional redirect when the provider supports mobile app callbacks.")
          .addText((text) => text.setValue(MCP_OAUTH_OBSIDIAN_REDIRECT_URI).setDisabled(true))
          .addButton((button) =>
            button.setButtonText("Copy").onClick(async () => {
              if (await this.copyToClipboard(MCP_OAUTH_OBSIDIAN_REDIRECT_URI)) {
                new Notice("MCP OAuth mobile redirect URI copied.");
              } else {
                new Notice(`MCP OAuth mobile redirect URI: ${MCP_OAUTH_OBSIDIAN_REDIRECT_URI}`);
              }
            }),
          );
      }),
      this.row("OAuth client id", (setting) => {
        setting
          .setDesc("Optional. Leave empty to use dynamic client registration when the server supports it.")
          .addText((text) =>
            text.setValue(server.oauth.clientId).onChange(async (value) => {
              server.oauth.clientId = value.trim();
              server.oauth.dynamicClientRegistration = false;
              server.oauth.registeredRedirectUri = "";
              this.syncMcpServerToState(server);
              await this.save();
            }),
          );
      }),
      this.secretInputDef({
        name: "OAuth client secret",
        desc: "Optional. Most MCP OAuth servers use public clients with PKCE and no secret.",
        placeholder: "client secret",
        hasValue: () => Boolean(server.oauth.clientSecret),
        onSet: async (value) => {
          server.oauth.clientSecret = value;
          server.oauth.dynamicClientRegistration = false;
          server.oauth.registeredRedirectUri = "";
          this.syncMcpServerToState(server);
          await this.save();
        },
        onForget: async () => {
          server.oauth.clientSecret = "";
          server.oauth.dynamicClientRegistration = false;
          server.oauth.registeredRedirectUri = "";
          this.syncMcpServerToState(server);
          await this.save();
        },
      }),
    ];
  }

  private async refreshMcpKnownTools(server: McpServerSettings, button?: ButtonComponent): Promise<void> {
    button?.setDisabled(true);
    try {
      const result = await this.probeAndCacheMcpTools(server);
      const sample = formatMcpToolSample(result.toolNames);
      new Notice(
        `${server.name}: refreshed ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}${sample}.`,
      );
      this.redraw();
    } catch (error) {
      new Notice(`Agentic chat: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      button?.setDisabled(false);
    }
  }

  private async probeAndCacheMcpTools(server: McpServerSettings): Promise<Awaited<ReturnType<typeof probeMcpServer>>> {
    const endpointProblem = mcpEndpointProblem(server.url);
    if (endpointProblem) throw new Error(endpointProblem);
    const result = await probeMcpServer(server, createMcpFetcher(this.effectiveMcpProxySettings()), {
      onServerChanged: async (changed) => {
        this.syncMcpServerToState(changed);
        await this.save();
      },
    });
    server.knownTools = result.tools;
    server.enabled = true;
    this.syncMcpServerToState(server);
    await this.save();
    return result;
  }

  private async testMcpServer(server: McpServerSettings): Promise<void> {
    const result = await this.probeAndCacheMcpTools(server);
    const sample = formatMcpToolSample(result.toolNames);
    new Notice(
      `${server.name}: connected; discovered ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}${sample}.`,
    );
    this.redraw();
  }

  private async authenticateAndProbeMcpServer(server: McpServerSettings): Promise<void> {
    const fetcher = createMcpFetcher(this.effectiveMcpProxySettings());
    await authenticateMcpServer(server, fetcher, {
      callbackReceiver: Platform.isMobileApp ? this.plugin.createMcpOAuthCallbackReceiver() : undefined,
      onProgress: (event) => this.handleMcpOAuthProgress(server, event),
    });
    this.syncMcpServerToState(server);
    const result = await probeMcpServer(server, fetcher, {
      onServerChanged: async (changed) => {
        this.syncMcpServerToState(changed);
        await this.save();
      },
    });
    server.knownTools = result.tools;
    this.syncMcpServerToState(server);
    await this.save();
    const sample = formatMcpToolSample(result.toolNames);
    new Notice(
      `Authenticated ${server.name}; discovered ${result.toolCount} tool${
        result.toolCount === 1 ? "" : "s"
      }${sample}.`,
    );
    this.redraw();
  }

  private effectiveMcpProxySettings(): NetworkSettings {
    const { network, mcp } = this.plugin.settings;
    return effectiveProxy(mcp, network);
  }

  /**
   * The HTTP-proxy + no-proxy row pair shared by the network, MCP, and
   * observability tabs. Only the descriptions differ per tab; persistence is
   * delegated so each tab writes its own settings slice.
   */
  private warning(icon: string, text: string): SettingDefinitionRender {
    return this.block((setting) => {
      const warning = setting.settingEl.createDiv({ cls: "agentic-chat-settings-warning" });
      warning.createSpan({ cls: "agentic-chat-settings-warning-icon", text: icon });
      warning.createSpan({ text });
    });
  }

  /** Explain how secrets are persisted for provider and tool credentials. */
  private apiKeyWarning(): SettingDefinitionRender {
    return this.warning(
      "i",
      "API keys and OAuth tokens are stored with Obsidian secret storage. The vault data.json stores " +
        "only secret IDs, not the secret values.",
    );
  }

  private secretInputDef(options: {
    name: string;
    desc: string;
    placeholder: string;
    hasValue: () => boolean;
    onSet: (value: string) => Promise<void>;
    onForget: () => Promise<void>;
  }): SettingDefinitionRender {
    return this.row(options.name, (setting) => {
      const status = options.hasValue()
        ? "A value is stored with Obsidian secret storage. Enter a new value to replace it."
        : "No value is stored yet.";
      setting.setDesc(`${options.desc} ${status}`).addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(options.placeholder).setValue("").onChange(async (value) => {
          const trimmed = value.trim();
          if (!trimmed) return;
          await options.onSet(trimmed);
        });
      });
      setting.addButton((button) =>
        button
          .setButtonText("Forget")
          .setDisabled(!options.hasValue())
          .onClick(async () => {
            button.setDisabled(true);
            await options.onForget();
            this.redraw();
          }),
      );
    });
  }

  private handleMcpOAuthProgress(server: McpServerSettings, event: McpOAuthProgressEvent): void {
    if (event.stage === "authorization-url") {
      const authorizationUrl = event.detail ?? "";
      console.warn(
        `Agentic Chat MCP OAuth: authorization URL for ${server.name}; copy this into a browser if no tab opens: ${authorizationUrl}`,
      );
      if (authorizationUrl) {
        void this.copyToClipboard(authorizationUrl).then((copied) => {
          if (copied) {
            new Notice(`${server.name}: OAuth authorization URL copied. Use it if the browser does not open.`);
          } else {
            new Notice(`${server.name}: OAuth authorization URL: ${authorizationUrl}`, 0);
          }
        });
      }
      return;
    }
    if (
      event.stage === "discovery" ||
      event.stage === "registration" ||
      event.stage === "browser-open" ||
      event.stage === "callback-wait"
    ) {
      new Notice(`${server.name}: ${event.message}`);
    }
  }

  private async runMcpButtonAction(
    button: ButtonComponent,
    label: string,
    busyLabel: string,
    action: () => Promise<void>,
  ): Promise<void> {
    button.setDisabled(true);
    button.setButtonText(busyLabel);
    try {
      await action();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // For OAuth-required (authType none/bearer/header but server advertises resource_metadata), the client already set
      // pendingOAuthChallenge on the server. Show a banner + redraw so Authenticate & test appears without manual dropdown.
      if (msg.includes("requires OAuth") || (error as { resourceUrl?: string })?.resourceUrl) {
        new Notice(`Agentic Chat MCP: ${msg} — check the OAuth banner below.`);
        this.redraw();
      } else {
        new Notice(`Agentic Chat MCP: ${msg}`);
      }
    } finally {
      button.setButtonText(label);
      button.setDisabled(false);
    }
  }

  private async copyToClipboard(value: string): Promise<boolean> {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) return false;
    try {
      await clipboard.writeText(value);
      return true;
    } catch {
      return false;
    }
  }

  private nextMcpServerId(
    settings: AgenticChatSettings,
    base: string,
    current?: McpServerSettings,
  ): string {
    const used = new Set([
      ...settings.mcp.servers.filter((entry) => entry !== current).map((entry) => entry.id),
      ...Object.keys(settings.plugins.mcpState).filter((id) => id !== current?.id),
    ]);
    return nextUniqueMcpServerId(base, used);
  }

  private updateMcpServerEndpoint(
    settings: AgenticChatSettings,
    server: McpServerSettings,
    value: string,
  ): { clearedCredentials: boolean; shouldDisplay: boolean } {
    const previousUrl = server.url;
    const previousId = server.id;
    const previousEndpointProblem = mcpEndpointProblem(previousUrl);
    const wasEnabled = server.enabled;
    server.url = value.trim();
    const suggestedId = serverIdFromMcpUrl(server.url);
    if (suggestedId && previousId === "mcp" && (!previousUrl || previousUrl === "https://")) {
      this.renameMcpServer(settings, server, this.nextMcpServerId(settings, suggestedId, server));
    }
    let clearedCredentials = false;
    if (previousUrl.trim() !== server.url.trim()) {
      this.clearMcpKnownToolsAndApprovals(settings, server);
      if (mcpCredentialResourceChanged(previousUrl, server.url)) {
        resetMcpCredentials(server);
        clearedCredentials = true;
      }
    }
    if (!mcpEndpointProblem(server.url)) server.enabled = true;
    this.syncMcpServerToState(server);
    return {
      clearedCredentials,
      shouldDisplay:
        Boolean(previousEndpointProblem) !== Boolean(mcpEndpointProblem(server.url)) ||
        wasEnabled !== server.enabled ||
        previousId !== server.id,
    };
  }

  private renameMcpServer(settings: AgenticChatSettings, server: McpServerSettings, nextId: string): void {
    const previousId = server.id;
    if (previousId === nextId) return;
    const previousSecretIds = mcpSecretIds(server);
    const previousApprovals = this.deleteMcpPerToolApprovals(settings, previousId);
    const previousLocalNames = server.knownTools.map((tool) => mcpKnownToolLocalName(server, tool));
    const previousState = settings.plugins.mcpState[previousId];
    server.id = nextId;
    resetMcpServerSecretRefs(server);
    if (previousState && server.source === "plugin") {
      settings.plugins.mcpState[nextId] = previousState;
      // Re-key secret ids inside the moved state
      previousState.authHeaderValueSecretId = server.authHeaderValueSecretId;
      previousState.oauth.clientSecretSecretId = server.oauth.clientSecretSecretId;
      previousState.oauth.accessTokenSecretId = server.oauth.accessTokenSecretId;
      previousState.oauth.refreshTokenSecretId = server.oauth.refreshTokenSecretId;
      delete settings.plugins.mcpState[previousId];
    }
    this.clearSecretIds(previousSecretIds.filter((id) => !mcpSecretIds(server).includes(id)));
    this.rebaseMcpKnownToolLocalNames(server);
    for (let index = 0; index < server.knownTools.length; index += 1) {
      const policy = previousApprovals[previousLocalNames[index]];
      const nextLocalName = mcpKnownToolLocalName(server, server.knownTools[index]);
      if (policy) setPerToolApproval(settings.approval, nextLocalName, policy);
    }
    this.syncMcpServerToState(server);
  }

  private clearMcpKnownToolsAndApprovals(settings: AgenticChatSettings, server: McpServerSettings): void {
    this.deleteMcpPerToolApprovals(settings, server.id);
    server.knownTools = [];
    this.syncMcpServerToState(server);
  }

  private clearMcpSecretSlots(server: McpServerSettings): void {
    this.clearSecretIds(mcpSecretIds(server));
  }

  private clearSecretIds(secretIds: string[]): void {
    const app = (this as { app?: App & { secretStorage?: { setSecret?: (id: string, value: string) => void } } }).app;
    const secretStorage = app?.secretStorage;
    if (!secretStorage?.setSecret) return;
    for (const id of secretIds) {
      try {
        secretStorage.setSecret(id, "");
      } catch (error) {
        console.warn(`Agentic Chat: failed to clear secret ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private deleteMcpPerToolApprovals(settings: AgenticChatSettings, serverId: string): Record<string, ApprovalPolicy> {
    return clearMcpPerToolApprovals(settings.approval, serverId);
  }

  private rebaseMcpKnownToolLocalNames(server: McpServerSettings): void {
    const localNames = localMcpToolNames(server.id, server.knownTools.map((tool) => tool.name));
    for (let index = 0; index < server.knownTools.length; index += 1) {
      server.knownTools[index].localName = localNames[index];
    }
  }

  private notificationDefinitions(): SettingDefinitionItem[] {
    return [
      this.controlDef(
        "Background notifications",
        { type: "toggle", key: "notifications.enabled" },
        "Show toasts for background signals (agent finished while you're elsewhere, context window filling, cost cap). Errors always show.",
      ),
      this.controlDef(
        "Cost alert (USD)",
        { type: "number", key: "notifications.costAlertUsd", min: 0, step: "any" },
        "Notify once when a conversation's cost crosses this amount. 0 disables.",
      ),
      this.controlDef(
        "Hard spend cap (USD)",
        { type: "number", key: "notifications.costCapUsd", min: 0, step: "any" },
        "Block new turns — and stop a turn already running — once this conversation's cost reaches this amount. " +
          "0 disables. Applies only to models with known pricing.",
      ),
    ];
  }

  private pluginDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    const items: SettingDefinitionItem[] = [
      this.block((setting) => {
        setting.settingEl.createDiv({ cls: "setting-item-description" }).createSpan({
          text:
            "Plugins are packages in the vault that contribute skills and MCP servers. They follow the " +
            "Agent Plugins 1.0.0 specification and are the single source of truth for skills and MCP. " +
            "Skill precedence: plugin skills win over built-ins of the same name. " +
            "The my-skills package is your personal collection space for hand-curated custom skills.",
        });
      }),
      this.row("Import", (setting) => {
        setting
          .setClass("agentic-chat-plugins-import")
          .addButton((button) =>
            button
              .setButtonText("Install plugin…")
              .setCta()
              .onClick(() => this.openInstallModal()),
          )
          .addButton((button) =>
            button.setButtonText("New skill…").onClick(() => {
              new NewSkillModal(this.app, this.plugin.pluginService, (result) => {
                noticeInstallResult(result);
                this.pluginsLoadedOnce = false;
                void this.save().then(() => this.redraw());
              }).open();
            }),
          )
          .addButton((button) =>
            button
              .setButtonText("Repair built-ins")
              .setDisabled(!this.builtinsPackageExists(settings))
              .onClick(async () => {
                await this.plugin.pluginService.repairBuiltins();
                new Notice("Built-in skill package recreated.");
                this.pluginsLoadedOnce = false;
                await this.save();
                this.redraw();
              }),
          );
      }),
      this.row("Plugins folder", (setting) => {
        setting
          .setDesc("Vault folder scanned for agent plugin packages (plugin.json + skills/ + mcp.json).")
          .addText((text) => {
            text.setPlaceholder("(none)").setValue(settings.plugins.folder).onChange((next) => {
              void this.setPluginsFolder(settings, next.trim());
            });
            text.inputEl.addClass("agentic-chat-folder-input");
          })
          .addButton((button) =>
            button.setButtonText("Browse").onClick(() => {
              new FolderSuggestModal(this.app, (folder) => {
                const path = folder.path === "/" ? "" : folder.path;
                void this.setPluginsFolder(settings, path);
              }).open();
            }),
          );
      }),
    ];
    items.push(...this.pluginListDefinitions(settings));
    return items;
  }

  private async setPluginsFolder(settings: AgenticChatSettings, value: string): Promise<void> {
    settings.plugins.folder = value;
    this.plugin.pluginService.invalidate();
    this.pluginsLoadedOnce = false;
    await this.save();
    this.redraw();
  }

  private subagentDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    return [
      this.row("Subagent timeout", (setting) => {
        setting
          .setDesc(
            "Auto-stop a subagent that runs longer than this many seconds (0 disables, max 86400). " +
              "The child is aborted and the Dispatch step settles as stopped.",
          )
          .addText((text) =>
            text
              .setPlaceholder("0 = disabled")
              .setValue(settings.subagentTimeoutSeconds > 0 ? String(settings.subagentTimeoutSeconds) : "")
              .onChange(async (value) => {
                // Same heal path as load: whole seconds clamped to [0, 24h].
                settings.subagentTimeoutSeconds = healSubagentTimeout(Number(value));
                await this.save();
              }),
          );
      }),
    ];
  }

  private retrievalDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    return [
      this.controlDef(
        "Embeddings",
        { type: "toggle", key: "embeddings.enabled" },
        "Opt-in semantic index configuration. Indexing is still scoped and explicit; provider API keys reuse the Models tab.",
      ),
      this.controlDef(
        "Embedding provider",
        {
          type: "dropdown",
          key: "embeddings.provider",
          options: {
            openrouter: "OpenRouter",
            ollama: "Ollama (local)",
            "openai-compatible": "OpenAI-compatible",
          },
        },
        "OpenRouter for hosted embeddings, Ollama for local embeddings, or the configured OpenAI-compatible gateway.",
      ),
      this.row("Embedding model", (setting) => {
        setting
          .setDesc(`Active embedding model: ${activeEmbeddingModel(settings.embeddings) || "(none configured)"}.`)
          .addText((text) =>
            text
              .setPlaceholder(embeddingModelPlaceholder(settings.embeddings.provider))
              .setValue(activeEmbeddingModel(settings.embeddings))
              .onChange(async (value) => {
                this.setEmbeddingModel(settings, value);
                await this.save();
              }),
          );
      }),
      this.row("Vector dimensions", (setting) => {
        setting
          .setDesc("Expected embedding vector size. Provider responses with a different size are rejected before indexing.")
          .addText((text) => {
            text.inputEl.type = "number";
            text.inputEl.setAttribute("min", "16");
            text.inputEl.setAttribute("max", "16384");
            text.setValue(String(settings.embeddings.dimensions)).onChange(async (value) => {
              const parsed = Number.parseInt(value, 10);
              settings.embeddings.dimensions = Number.isFinite(parsed)
                ? Math.min(16_384, Math.max(16, parsed))
                : DEFAULT_EMBEDDING_SETTINGS.dimensions;
              await this.save();
            });
          });
      }),
      this.controlDef(
        "Language coverage",
        {
          type: "dropdown",
          key: "embeddings.languageCoverage",
          options: { multilingual: "Multilingual", monolingual: "Monolingual", unknown: "Unknown" },
        },
        "Controls retrieval diagnostics for cross-language search.",
      ),
      this.row("Batch size", (setting) => {
        setting
          .setDesc("Maximum notes per embedding request. Smaller batches are easier to cancel and retry.")
          .addText((text) => {
            text.inputEl.type = "number";
            text.inputEl.setAttribute("min", "1");
            text.inputEl.setAttribute("max", "256");
            text.setValue(String(settings.embeddings.batchSize)).onChange(async (value) => {
              const parsed = Number.parseInt(value, 10);
              settings.embeddings.batchSize = Number.isFinite(parsed)
                ? Math.min(256, Math.max(1, parsed))
                : DEFAULT_EMBEDDING_SETTINGS.batchSize;
              await this.save();
            });
          });
      }),
      this.row("Max indexed characters per note", (setting) => {
        setting
          .setDesc("Upper bound sent to the embedding provider for one note. Keeps cost and accidental data exposure bounded.")
          .addText((text) => {
            text.inputEl.type = "number";
            text.inputEl.setAttribute("min", "500");
            text.inputEl.setAttribute("max", "200000");
            text.setValue(String(settings.embeddings.maxDocumentChars)).onChange(async (value) => {
              const parsed = Number.parseInt(value, 10);
              settings.embeddings.maxDocumentChars = Number.isFinite(parsed)
                ? Math.min(200_000, Math.max(500, parsed))
                : DEFAULT_EMBEDDING_SETTINGS.maxDocumentChars;
              await this.save();
            });
          });
      }),
    ];
  }

  private ignoredFileDefinitions(): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    return [
      this.row("Ignore list", (setting) => {
        setting
          .setDesc(
            "One gitignore-style glob per line. Matching notes are invisible to the agent — it cannot read, " +
              "list, search, or edit them. Examples: Private/  ·  *.secret.md  ·  /Inbox/passwords.md  ·  **/diary/**",
          )
          .addTextArea((text) => {
            text.inputEl.rows = 6;
            text.inputEl.addClass("agentic-chat-system-prompt");
            text.setPlaceholder("Private/\n*.secret.md").setValue(settings.ignoredGlobs).onChange(async (value) => {
              settings.ignoredGlobs = value;
              await this.save();
            });
          });
      }),
    ];
  }

  private pluginListDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    this.ensurePluginsLoaded();
    return [
      this.block(
        (setting) => {
          // Read the loaded packages at render time so a package installed or
          // deleted while the settings tab was closed is reflected on open.
          const plugins = this.plugin.pluginService.getLoaded();
          const deleted = this.externallyDeletedPlugins;
          if (plugins.length === 0 && deleted.length === 0) {
            setting.settingEl.createDiv({
              cls: "setting-item-description",
              text:
                "No agent plugins found. Use “Install plugin…” to bring one in from GitHub or an archive " +
                "(Claude/Copilot/VS Code packages are converted automatically), or “New skill…” to scaffold your own.",
            });
            return;
          }

          const items: SettingDefinitionItem[] = [];
          if (plugins.length > 0) {
            items.push(this.heading("Installed plugins"));
            for (const plugin of plugins) {
              items.push(this.pluginRowDefinition(settings, plugin));
            }
          }
          if (deleted.length > 0) {
            items.push(
              this.heading("Deleted on disk"),
              this.block((row) => {
                row.settingEl.createDiv({
                  cls: "setting-item-description",
                  text: "These plugins were deleted outside Obsidian. Settings were cleaned; dismiss this notice when ready.",
                });
              }),
            );
            for (const plugin of deleted) {
              items.push(this.deletedPluginRowDefinition(settings, plugin));
            }
            items.push(
              this.row("", (row) => {
                row.addButton((button) =>
                  button.setButtonText("Dismiss").onClick(() => {
                    this.externallyDeletedPlugins = [];
                    this.redraw();
                  }),
                );
              }),
            );
          }
          this.renderItemsInto(setting.settingEl, items);
        },
        { name: "Installed plugins", visible: true },
      ),
    ];
  }

  private pluginRowDefinition(settings: AgenticChatSettings, plugin: LoadedPlugin): SettingDefinitionRender {
    return this.row(plugin.name, (setting) => {
      setting.settingEl.empty();
      setting.settingEl.addClass("agentic-chat-plugin-row");

      const main = setting.settingEl.createDiv({ cls: "agentic-chat-plugin-main" });
      main.createDiv({ cls: "agentic-chat-plugin-name", text: plugin.name });

      const status = plugin.enabled ? plugin.auditStatus : "disabled";
      const typeCounts =
        `${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"}, ` +
        `${plugin.mcpServers.length} MCP server${plugin.mcpServers.length === 1 ? "" : "s"}`;
      const meta = main.createDiv({ cls: "agentic-chat-plugin-meta" });
      meta.createSpan({ text: `${plugin.rootPath} — ${status}, ${typeCounts}` });
      const extra: string[] = [];
      if (plugin.version) extra.push(`v${plugin.version}`);
      if (plugin.manifestProblem) extra.push(plugin.manifestProblem);
      if (plugin.reports.length > 0) extra.push(plugin.reports.map((report) => report.message).join("; "));
      const source = settings.plugins.sources?.[plugin.name];
      if (source) extra.push(`Source: ${source}`);
      if (extra.length > 0) {
        const tail = meta.createSpan({ cls: "agentic-chat-plugin-meta-extra" });
        tail.createSpan({ text: ` — ${extra.join(" · ")}` });
      }

      const controls = setting.settingEl.createDiv({ cls: "agentic-chat-plugin-controls" });
      new ToggleComponent(controls)
        .setValue(plugin.enabled)
        .setTooltip(`Enable ${plugin.name}`)
        .onChange(async (value) => {
          const enabled = { ...settings.plugins.enabled };
          if (value) delete enabled[plugin.name];
          else enabled[plugin.name] = false;
          settings.plugins.enabled = enabled;
          this.plugin.pluginService.invalidate();
          this.pluginsLoadedOnce = false;
          await this.save();
          this.redraw();
        });
      new ButtonComponent(controls)
        .setButtonText("Open folder")
        .onClick(() => this.openInVault(plugin.rootPath));
      new ButtonComponent(controls)
        .setButtonText("Remove")
        .setDestructive()
        .onClick(async () => {
          const existed = await this.plugin.pluginService.removePackage(plugin.name, plugin.rootPath);
          if (existed) new Notice(`Removed agent plugin "${plugin.name}".`);
          else new Notice(`Agent plugin "${plugin.name}" was already deleted on disk — settings cleaned.`);
          this.pluginsLoadedOnce = false;
          await this.save();
          this.redraw();
        });
    });
  }

  private deletedPluginRowDefinition(settings: AgenticChatSettings, plugin: LoadedPlugin): SettingDefinitionRender {
    return this.row(plugin.name, (setting) => {
      setting.settingEl.empty();
      setting.settingEl.addClass("agentic-chat-plugin-row", "agentic-chat-plugin-deleted");
      const main = setting.settingEl.createDiv({ cls: "agentic-chat-plugin-main" });
      main.createDiv({ cls: "agentic-chat-plugin-name", text: plugin.name });
      const meta = main.createDiv({ cls: "agentic-chat-plugin-meta" });
      meta.createSpan({ text: `${plugin.rootPath} — deleted on disk` });
      const source = settings.plugins.sources?.[plugin.name];
      if (source) {
        const tail = meta.createSpan({ cls: "agentic-chat-plugin-meta-extra" });
        tail.createSpan({ text: ` — Source: ${source}` });
      }
      const controls = setting.settingEl.createDiv({ cls: "agentic-chat-plugin-controls" });
      new ButtonComponent(controls)
        .setButtonText("Dismiss")
        .onClick(async () => {
          // Guard the TOCTOU: if the folder was recreated since the transient was shown, don't delete it.
          let shouldRemove: boolean;
          try {
            shouldRemove = !(await this.app.vault.adapter.exists(plugin.rootPath));
          } catch {
            shouldRemove = false;
          }
          if (shouldRemove) await this.plugin.pluginService.removePackage(plugin.name, plugin.rootPath);
          this.externallyDeletedPlugins = this.externallyDeletedPlugins.filter((entry) => entry.rootPath !== plugin.rootPath);
          this.redraw();
        });
    });
  }

  private openInstallModal(): void {
    new InstallPluginModal(this.app, this.plugin.pluginService, (result) => {
      noticeInstallResult(result);
      this.pluginsLoadedOnce = false;
      void this.save().then(() => this.redraw());
    }).open();
  }

  private builtinsPackageExists(settings: AgenticChatSettings): boolean {
    const folder = settings.plugins.folder.trim() || DEFAULT_PLUGINS_FOLDER;
    const entry = this.app.vault.getAbstractFileByPath(`${folder}/builtins`);
    return entry instanceof TFolder;
  }

  private openInVault(path: string): void {
    const entry = this.app.vault.getAbstractFileByPath(path);
    if (!entry) {
      new Notice(`Agentic Chat: ${path} no longer exists.`);
      return;
    }
    const vault = this.app.vault as unknown as { open?: (path: string) => Promise<void> };
    if (entry instanceof TFolder) {
      // WorkspaceLeaf.openFile only accepts files; folders get revealed in
      // the File Explorer view when one exists.
      const fileExplorer = this.app.workspace.getLeavesOfType("file-explorer")[0];
      const view = fileExplorer?.view as { revealInFolder?: (folder: TFolder) => void } | undefined;
      if (fileExplorer && view?.revealInFolder) {
        void this.app.workspace.revealLeaf(fileExplorer);
        view.revealInFolder(entry);
        return;
      }
      if (vault.open) void vault.open(`/${path}`);
      return;
    }
    if (!(entry instanceof TFile)) return;
    const fileExplorer = this.app.workspace.getLeavesOfType("file-explorer")[0];
    if (fileExplorer) {
      void fileExplorer.openFile(entry);
      return;
    }
    if (vault.open) void vault.open(`/${path}`);
  }

  private setEmbeddingModel(settings: AgenticChatSettings, value: string): void {
    const model = value.trim();
    if (settings.embeddings.provider === "ollama") settings.embeddings.ollamaModel = model;
    else if (settings.embeddings.provider === "openai-compatible") settings.embeddings.openaiCompatibleModel = model;
    else settings.embeddings.openrouterModel = model;
  }
}
