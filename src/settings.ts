import {
  App,
  ButtonComponent,
  Notice,
  PluginSettingTab,
  TFile,
  TFolder,
  ToggleComponent,
  type SettingControl,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
  type SettingDefinitionPage,
  type SettingDefinitionRender,
} from "obsidian";
import type AgenticChatPlugin from "./main";
import { DEFAULT_PLUGINS_FOLDER } from "./plugins/loader";
import type { LoadedPlugin } from "./plugins/loader";
import { createMcpServerState } from "./mcp/settings";
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  listOpenRouterModels,
} from "./llm/models";
import { type ApprovalPolicy, clearMcpPerToolApprovals, setPerToolApproval } from "./agent/approval";
import { type AgentMode, MODE_ORDER, MODES } from "./agent/modes";
import { DEFAULT_SYSTEM_PROMPT } from "./agent/system-prompt";
import { MUTATING_TOOLS } from "./tools/tool-contracts";
import { createVaultTools } from "./tools/vault-tools";
import { errorMessage } from "./utils/errors";
import { createFetchFromWebFetcher, createProxiedFetcher } from "./mcp/fetcher";
import { WEB_SEARCH_PROVIDER_LABELS, WEB_SEARCH_PROVIDERS } from "./tools/web-search";
import { FolderSuggestModal } from "./ui/folder-suggest";
import { InstallPluginModal, noticeInstallResult } from "./ui/install-plugin-modal";
import { NewSkillModal } from "./ui/new-skill-modal";
import { ModelSuggestModal } from "./ui/model-suggest-modal";
import { indexControls, normalizeControlValue } from "./settings-controls";
import {
  apiKeyWarning,
  block,
  controlDef,
  headingRow,
  renderItemsInto,
  row,
  secretInputDef,
  warning,
} from "./settings-definition-kit";
import { McpSettingsSection } from "./settings-mcp-section";
import {
  type ObservabilityBackend,
  type ObservabilityPayloadMode,
} from "./observability/settings";
import { activeEmbeddingModel, DEFAULT_EMBEDDING_SETTINGS } from "./retrieval/embeddings";

import { DEFAULT_PROXY_SETTINGS, PROXY_URL_EXAMPLE } from "./network/proxy";
import { normalizeAllowedHosts } from "./tools/web-allowlist";
import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  PROVIDER_LABELS,
  embeddingModelPlaceholder,
  healSubagentTimeout,
  type AgenticChatSettings,
} from "./settings-schema";
import { SETTINGS_TABS, type SettingsSectionId, type SettingsTabId } from "./settings-tabs";
import { MAX_TURN_CAP, MIN_TURN_CAP } from "./agent/turn-cap";
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
    return this.buildDefinitions(this.plugin.settings);
  }

  /**
   * Every page built against `settings`. Builders read only this argument, so
   * indexing a hypothetical configuration never touches the live settings.
   */
  private buildDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    const pages = this.tabs.map((tab) => {
      const page: SettingDefinitionPage & { id: string } = {
        type: "page",
        id: tab.id,
        name: tab.label,
        items: tab.sections.map((section) => this.sectionDefinition(tab.id, section, settings)),
      };
      return page;
    });
    // Merge, not replace: a row hidden now (e.g. web.searchProvider while web is off) keeps its schema.
    indexControls(pages, this.controlIndex);
    return pages;
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
    // One gate for every key (#286): trim text, reject unknown enums and wrong types, clamp numbers.
    const next = normalizeControlValue(this.controlFor(key), value, this.getControlValue(key));
    switch (key) {
      case "openaiCompatibleBaseUrl":
        settings.openaiCompatibleBaseUrl = controlText(next).trim() || DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
        break;
      case "ollamaBaseUrl":
        settings.ollamaBaseUrl = controlText(next).trim() || DEFAULT_OLLAMA_BASE_URL;
        break;
      case "systemPrompt":
        settings.systemPrompt = controlText(next).trim() ? controlText(next) : DEFAULT_SYSTEM_PROMPT;
        break;
      case "plugins.folder":
        settings.plugins.folder = controlText(next).trim();
        this.plugin.pluginService.invalidate();
        this.pluginsLoadedOnce = false;
        break;
      default:
        this.writeControlValue(settings, key, next);
    }
    await this.save();
    if (CONTROL_KEYS_THAT_REDRAW.has(key)) this.redraw();
  }

  /** The declarative control for a key, including rows the current settings hide. */
  private controlFor(key: string): SettingControl | undefined {
    if (!this.controlIndex.has(key)) this.getSettingDefinitions();
    if (!this.controlIndex.has(key) && !this.hiddenControlsIndexed) this.indexHiddenControls();
    return this.controlIndex.get(key);
  }

  /**
   * Index rows the live settings hide (web or observability off, another
   * provider's fields) by building the definitions once per provider against a
   * clone with every section on. The clone is only read for control schemas;
   * its rows are never rendered.
   */
  private indexHiddenControls(): void {
    this.hiddenControlsIndexed = true;
    for (const provider of PROVIDERS) {
      const shadow = structuredClone(this.plugin.settings);
      shadow.provider = provider;
      shadow.web.enabled = true;
      shadow.web.searchProvider = "searxng";
      shadow.observability.enabled = true;
      this.buildDefinitions(shadow);
    }
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

  private sectionDefinition(
    tabId: SettingsTabId,
    section: SettingsSectionId,
    settings: AgenticChatSettings,
  ): SettingDefinitionGroup {
    const items: SettingDefinitionItem[] = [this.sectionMarker(tabId, section)];
    switch (section) {
      case "models":
        items.push(...this.modelsDefinitions(settings));
        break;
      case "agent":
        items.push(...this.agentDefinitions(settings));
        break;
      case "approval":
        items.push(...this.approvalDefinitions(settings));
        break;
      case "web":
        items.push(...this.webDefinitions(settings));
        break;
      case "mcp":
        items.push(...this.mcpSection.definitions(settings));
        break;
      case "observability":
        items.push(...this.observabilityDefinitions(settings));
        break;
      case "notifications":
        items.push(...this.notificationDefinitions());
        break;
      case "plugins":
        items.push(...this.pluginDefinitions(settings));
        break;
      case "subagents":
        items.push(...this.subagentDefinitions(settings));
        break;
      case "retrieval":
        items.push(...this.retrievalDefinitions(settings));
        break;
      case "ignored-files":
        items.push(...this.ignoredFileDefinitions(settings));
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

  /** Built on first use: unit tests create the tab from its prototype without a constructor. */
  private get mcpSection(): McpSettingsSection {
    this.mcpSectionInstance ??= new McpSettingsSection({
      app: this.app,
      plugin: this.plugin,
      save: () => this.save(),
      redraw: () => this.redraw(),
      ensurePluginsLoaded: () => this.ensurePluginsLoaded(),
      invalidatePluginLoad: () => {
        this.pluginsLoadedOnce = false;
      },
    });
    return this.mcpSectionInstance;
  }

  private secretInputDef(options: Parameters<typeof secretInputDef>[0]): SettingDefinitionRender {
    return secretInputDef(options, () => this.redraw());
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
  /** Declarative controls by key, refreshed by getSettingDefinitions(); the schema setControlValue validates against. */
  private readonly controlIndex = new Map<string, SettingControl>();
  private hiddenControlsIndexed = false;
  private mcpSectionInstance: McpSettingsSection | undefined;
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

  private modelsDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    const items: SettingDefinitionItem[] = [
      controlDef(
        "Model provider",
        {
          type: "dropdown",
          key: "provider",
          options: Object.fromEntries(PROVIDERS.map((provider) => [provider, PROVIDER_LABELS[provider]])),
        },
        "OpenRouter with privacy routing, local Ollama, or any OpenAI-compatible gateway.",
      ),
      headingRow("Network proxy"),
      controlDef(
        "HTTP proxy",
        { type: "text", key: "network.proxyUrl", placeholder: PROXY_URL_EXAMPLE },
        "Optional HTTP proxy for plugin-owned network calls: OpenRouter/OpenAI-compatible chat, model browsing, web tools, and MCP unless MCP overrides it.",
      ),
      controlDef(
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
      apiKeyWarning(),
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
      row("Model", (setting) => {
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
                new Notice(`Agentic chat: ${errorMessage(error)}`);
              } finally {
                button.setDisabled(false);
              }
            }),
          );
      }),
      headingRow("Privacy"),
      controlDef(
        "Deny prompt logging and training",
        { type: "toggle", key: "privacy.denyDataCollection" },
        'Only route to providers that do not store or train on prompts (data policy "deny").',
      ),
      controlDef(
        "Require zero data retention",
        { type: "toggle", key: "privacy.requireZDR" },
        "On by default. Only route to ZDR endpoints; some models may have no compliant provider — pick another model or use Ollama.",
      ),
      controlDef(
        "Allow provider fallbacks",
        { type: "toggle", key: "privacy.allowFallbacks" },
        "Let OpenRouter fall back to other still-compliant providers when the preferred one is down.",
      ),
    ];
  }

  private ollamaDefinitions(): SettingDefinitionItem[] {
    return [
      controlDef(
        "Ollama server URL",
        { type: "text", key: "ollamaBaseUrl", placeholder: DEFAULT_OLLAMA_BASE_URL },
        "Base URL of your local Ollama server. The OpenAI-compatible endpoint is derived as <url>/v1.",
      ),
      controlDef(
        "Model",
        { type: "text", key: "ollamaModel", placeholder: "llama3.1" },
        "An installed Ollama model tag, e.g. llama3.1 or qwen2.5-coder.",
      ),
    ];
  }

  private openAICompatibleDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    const activePreset = openAICompatiblePresetForBaseUrl(settings.openaiCompatibleBaseUrl);
    return [
      apiKeyWarning(),
      row("Gateway preset", (setting) => {
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
      controlDef(
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
      controlDef(
        "Model",
        {
          type: "text",
          key: "openaiCompatibleModel",
          placeholder: activePreset?.modelPlaceholder ?? "qwen2.5-coder",
        },
        "Model id exposed by the configured gateway.",
      ),
      row("Context window (tokens)", (setting) => {
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

  private agentDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    return [
      row("Permission mode", (setting) => {
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
              dropdown.setValue(settings.mode);
            });
          });
      }),
      controlDef("Temperature", { type: "slider", key: "temperature", min: 0, max: 2, step: 0.1 }),
      controlDef(
        "Max response tokens",
        { type: "number", key: "maxTokens", min: 0 },
        "Per model request. 0 lets the provider decide.",
      ),
      row("Request timeout (seconds)", (setting) => {
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
      controlDef(
        "Network retries",
        { type: "slider", key: "maxNetworkRetries", min: 0, max: 5, step: 1 },
        "Automatic retries on rate limits and transient server errors.",
      ),
      controlDef(
        "Max turns per prompt",
        { type: "number", key: "maxTurnsPerPrompt", min: MIN_TURN_CAP, max: MAX_TURN_CAP },
        `Stop the agent after this many model turns (${MIN_TURN_CAP}-${MAX_TURN_CAP}). ` +
          "Sending or steering a message starts a new count. Send another message to continue.",
      ),
      row("System prompt", (setting) => {
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
      headingRow("Context window"),
      controlDef(
        "Auto-compaction",
        { type: "toggle", key: "compaction.enabled" },
        "Summarize older turns automatically as the context window fills, so long conversations don't hit the " +
          "model limit or spike cost. The summary replaces the compacted turns in the transcript.",
      ),
      controlDef(
        "Compact at (% of context window)",
        { type: "slider", key: "compaction.thresholdPercent", min: 50, max: 95, step: 5 },
        "Trigger compaction once the conversation fills this share of the model's context window.",
      ),
      headingRow("Tool budget"),
      controlDef(
        "Drop optional tools when schemas are large",
        { type: "toggle", key: "toolBudget.enabled" },
        "When registered tool schemas alone exceed the threshold, hide optional expansion tools such as web, MCP, artifacts, PDF import, and subagents.",
      ),
      controlDef(
        "Drop tools when schemas exceed (% of context window)",
        { type: "slider", key: "toolBudget.thresholdPercent", min: 1, max: 50, step: 1 },
        "Low by default so large tool catalogs shed optional tools before tool schemas become expensive.",
      ),
    ];
  }

  private approvalDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    const items: SettingDefinitionItem[] = [
      controlDef(
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
      row("Per-tool overrides", (setting) => {
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
        row(tool.label, (setting) => {
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

  private webDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    const items: SettingDefinitionItem[] = [
      warning(
        "⚠",
        "Web search and fetch send your query text and the URLs the agent opens to a third-party " +
          "service, off-device — outside the vault's privacy boundary. Off by default; turn it on only " +
          "when you want the agent to use the open web.",
      ),
      controlDef(
        "Enable web search & fetch",
        { type: "toggle", key: "web.enabled" },
        "Give the agent web_search and fetch_url tools. When off, the agent cannot reach the network at all.",
      ),
    ];

    if (!settings.web.enabled) return items;

    items.push(
      controlDef(
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
        controlDef(
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
      controlDef(
        "Search results",
        { type: "slider", key: "web.maxResults", min: 1, max: 10, step: 1 },
        "How many results web_search returns by default.",
      ),
      row("Fetched page character limit", (setting) => {
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
      row("Allowed hosts", (setting) => {
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

  private observabilityDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    const items: SettingDefinitionItem[] = [
      warning(
        "i",
        "Observability is opt-in and has no built-in endpoint. When enabled, Agentic Chat exports " +
          "turn, model, tool, approval, token, and cost metadata to the endpoint you configure. Prompt " +
          "and answer text is withheld unless you explicitly change payload detail below.",
      ),
      controlDef(
        "Enable observability",
        { type: "toggle", key: "observability.enabled" },
        "Export OTLP/HTTP traces for agent turns. Leave off for the default no-telemetry behavior.",
      ),
    ];

    if (!settings.observability.enabled) return items;

    items.push(
      controlDef(
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
      controlDef(
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
      controlDef(
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
      controlDef(
        "Sample rate",
        { type: "slider", key: "observability.sampleRate", min: 0, max: 100, step: 1 },
        "Percentage of agent turns to export.",
      ),
      controlDef(
        "HTTP proxy",
        { type: "text", key: "observability.proxyUrl", placeholder: PROXY_URL_EXAMPLE },
        "Optional observability-only override. Leave empty to inherit the global network proxy from the Models tab.",
      ),
      controlDef(
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
      controlDef(
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

  private notificationDefinitions(): SettingDefinitionItem[] {
    return [
      controlDef(
        "Background notifications",
        { type: "toggle", key: "notifications.enabled" },
        "Show toasts for background signals (agent finished while you're elsewhere, context window filling, cost cap). Errors always show.",
      ),
      controlDef(
        "Cost alert (USD)",
        { type: "number", key: "notifications.costAlertUsd", min: 0, step: "any" },
        "Notify once when a conversation's cost crosses this amount. 0 disables.",
      ),
      controlDef(
        "Hard spend cap (USD)",
        { type: "number", key: "notifications.costCapUsd", min: 0, step: "any" },
        "Block new turns — and stop a turn already running — once this conversation's cost reaches this amount. " +
          "0 (or an empty field) turns the cap off. Applies only to models with known pricing.",
      ),
    ];
  }

  private pluginDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    const items: SettingDefinitionItem[] = [
      block((setting) => {
        setting.settingEl.createDiv({ cls: "setting-item-description" }).createSpan({
          text:
            "Plugins are packages in the vault that contribute skills and MCP servers. They follow the " +
            "Agent Plugins 1.0.0 specification and are the single source of truth for skills and MCP. " +
            "Skill precedence: plugin skills win over built-ins of the same name. " +
            "The my-skills package is your personal collection space for hand-curated custom skills.",
        });
      }),
      row("Import", (setting) => {
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
      row("Plugins folder", (setting) => {
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

  private subagentDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    return [
      row("Subagent timeout", (setting) => {
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

  private retrievalDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    return [
      controlDef(
        "Embeddings",
        { type: "toggle", key: "embeddings.enabled" },
        "Opt-in semantic index configuration. Indexing is still scoped and explicit; provider API keys reuse the Models tab.",
      ),
      controlDef(
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
      row("Embedding model", (setting) => {
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
      row("Vector dimensions", (setting) => {
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
      controlDef(
        "Language coverage",
        {
          type: "dropdown",
          key: "embeddings.languageCoverage",
          options: { multilingual: "Multilingual", monolingual: "Monolingual", unknown: "Unknown" },
        },
        "Controls retrieval diagnostics for cross-language search.",
      ),
      row("Batch size", (setting) => {
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
      row("Max indexed characters per note", (setting) => {
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

  private ignoredFileDefinitions(settings: AgenticChatSettings): SettingDefinitionItem[] {
    return [
      row("Ignore list", (setting) => {
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
      block(
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
            items.push(headingRow("Installed plugins"));
            for (const plugin of plugins) {
              items.push(this.pluginRowDefinition(settings, plugin));
            }
          }
          if (deleted.length > 0) {
            items.push(
              headingRow("Deleted on disk"),
              block((row) => {
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
              row("", (row) => {
                row.addButton((button) =>
                  button.setButtonText("Dismiss").onClick(() => {
                    this.externallyDeletedPlugins = [];
                    this.redraw();
                  }),
                );
              }),
            );
          }
          renderItemsInto(setting.settingEl, items);
        },
        { name: "Installed plugins", visible: true },
      ),
    ];
  }

  private pluginRowDefinition(settings: AgenticChatSettings, plugin: LoadedPlugin): SettingDefinitionRender {
    return row(plugin.name, (setting) => {
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
    return row(plugin.name, (setting) => {
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
