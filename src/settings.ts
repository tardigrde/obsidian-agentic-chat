import {
  App,
  PluginSettingTab,
  type SettingControl,
  type SettingDefinitionGroup,
  type SettingDefinitionItem,
  type SettingDefinitionPage,
  type SettingDefinitionRender,
} from "obsidian";
import type AgenticChatPlugin from "./main";
import { createMcpServerState } from "./mcp/settings";
import { clearAuthForUrlChange } from "./mcp/server-state";
import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL, DEFAULT_OLLAMA_BASE_URL } from "./llm/models";
import type { LoadedPlugin } from "./plugins/loader";
import { indexControls, normalizeControlValue } from "./settings-controls";
import { secretInputDef } from "./settings-definition-kit";
import { McpSettingsSection } from "./settings-mcp-section";
import {
  agentDefinitions,
  approvalDefinitions,
  notificationDefinitions,
  subagentDefinitions,
} from "./settings-tab-agent";
import type { SettingsTabHost } from "./settings-tab-host";
import { modelsDefinitions } from "./settings-tab-models";
import { pluginDefinitions } from "./settings-tab-plugins";
import { ignoredFileDefinitions, retrievalDefinitions } from "./settings-tab-retrieval";
import { observabilityDefinitions, webDefinitions } from "./settings-tab-web";
import { PROVIDERS, type AgenticChatSettings } from "./settings-schema";
import { SETTINGS_TABS, type SettingsSectionId, type SettingsTabId } from "./settings-tabs";

export {
  applyOpenAICompatiblePreset,
  OPENAI_COMPATIBLE_PRESETS,
  openAICompatiblePresetForBaseUrl,
  type OpenAICompatiblePreset,
} from "./settings-tab-models";

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

export class AgenticChatSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: AgenticChatPlugin,
  ) {
    super(app, plugin);
    this.host = {
      app,
      plugin,
      save: () => this.save(),
      redraw: () => this.redraw(),
      refresh: () => this.refresh(),
      ensurePluginsLoaded: () => this.ensurePluginsLoaded(),
      invalidatePluginLoad: () => {
        this.pluginsLoadedOnce = false;
      },
      externallyDeletedPlugins: () => this.externallyDeletedPlugins,
      setExternallyDeletedPlugins: (plugins) => {
        this.externallyDeletedPlugins = plugins;
      },
      secretInputDef: (options) => this.secretInputDef(options),
    };
  }

  private readonly host: SettingsTabHost;

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
      for (const backend of ["langfuse", "otlp"] as const) {
        const shadow = structuredClone(this.plugin.settings);
        shadow.provider = provider;
        shadow.web.enabled = true;
        shadow.web.searchProvider = "searxng";
        shadow.observability.enabled = true;
        shadow.observability.backend = backend;
        this.buildDefinitions(shadow);
      }
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
        items.push(...modelsDefinitions(settings, this.host));
        break;
      case "agent":
        items.push(...agentDefinitions(settings, this.host));
        break;
      case "approval":
        items.push(...approvalDefinitions(settings, this.host));
        break;
      case "web":
        items.push(...webDefinitions(settings, this.host));
        break;
      case "mcp":
        items.push(...this.mcpSection.definitions(settings));
        break;
      case "observability":
        items.push(...observabilityDefinitions(settings, this.host));
        break;
      case "notifications":
        items.push(...notificationDefinitions());
        break;
      case "plugins":
        items.push(...pluginDefinitions(settings, this.host));
        break;
      case "subagents":
        items.push(...subagentDefinitions(settings, this.host));
        break;
      case "retrieval":
        items.push(...retrievalDefinitions(settings, this.host));
        break;
      case "ignored-files":
        items.push(...ignoredFileDefinitions(settings, this.host));
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
        if (existing.lastUrl) clearAuthForUrlChange(existing);
        existing.lastUrl = server.url;
        mutated = true;
      }
    }
    // Orphaned mcpState (and its per-tool approvals) is pruned by
    // PluginService.reload(); this tab only creates entries and heals URLs, so
    // one prune path owns the guard.
    // Prune transient deleted cache entries that have reappeared (recreated outside)
    const alivePaths = new Set(plugins.map((plugin) => plugin.rootPath));
    this.externallyDeletedPlugins = this.externallyDeletedPlugins.filter((plugin) => !alivePaths.has(plugin.rootPath));
    return mutated;
  }
}
