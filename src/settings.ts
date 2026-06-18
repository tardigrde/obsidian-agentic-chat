import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { normalizeFolderPath } from "./vault/path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type AgenticChatPlugin from "./main";
import {
  DEFAULT_OLLAMA_BASE_URL,
  listOpenRouterModels,
  type ModelConfig,
  type PrivacySettings,
  type ProviderId,
} from "./llm/models";
import { type ApprovalPolicy, type ApprovalSettings, DEFAULT_APPROVAL_SETTINGS } from "./agent/approval";
import { type AgentMode, DEFAULT_MODE, healMode, MODES, TOGGLE_MODES } from "./agent/modes";
import { DEFAULT_OUTPUT_STYLE, type OutputStyle, OUTPUT_STYLES } from "./agent/output-styles";
import { DEFAULT_SYSTEM_PROMPT } from "./agent/system-prompt";
import { createVaultTools, MUTATING_TOOLS } from "./tools/vault-tools";
import {
  WEB_SEARCH_PROVIDER_LABELS,
  WEB_SEARCH_PROVIDERS,
  type WebSearchProvider,
} from "./tools/web-search";
import { FolderSuggestModal } from "./ui/folder-suggest";
import { ModelSuggestModal } from "./ui/model-suggest-modal";

export interface AgenticChatSettings {
  provider: ProviderId;
  openrouterApiKey: string;
  openrouterModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  thinkingLevel: ThinkingLevel;
  temperature: number;
  /** 0 means "let the provider decide". */
  maxTokens: number;
  requestTimeoutMs: number;
  maxNetworkRetries: number;
  systemPrompt: string;
  /**
   * Session permission posture: `safe` honors the approval policy, `yolo` auto-approves
   * mutating tools. `plan` (read-only) is reached via the `/plan` command, not this default.
   */
  mode: AgentMode;
  /** How the assistant talks: a built-in system-prompt overlay. */
  outputStyle: OutputStyle;
  privacy: PrivacySettings;
  approval: ApprovalSettings;
  /** Vault folder scanned for SKILL.md skills/personas. Empty disables skills. */
  skillsFolder: string;
  /** Vault folder scanned for reusable prompt templates. Empty disables templates. */
  templatesFolder: string;
  /** Vault folder scanned for AGENT.md subagent profiles. Empty disables vault profiles. */
  agentsFolder: string;
  /** Include the built-in subagent roster (researcher / reviewer / editor). */
  enableBuiltinAgents: boolean;
  /**
   * Newline-separated gitignore-style globs the agent may never read or see.
   * Enforced at the tool layer; matched files are invisible, not just denied.
   */
  ignoredGlobs: string;
  /** Background notification preferences (toasts for agent/context/cost signals). */
  notifications: NotificationSettings;
  /** Auto-compaction: summarize old turns as the context window fills. */
  compaction: CompactionSettings;
  /** Open-web access: search + fetch tools. Off by default — sends data off-device. */
  web: WebSettings;
}

export interface WebSettings {
  /**
   * Master egress gate for web search + fetch. Off by default. When off the web
   * tools are not registered at all, so the agent cannot reach the network.
   */
  enabled: boolean;
  /** Search backend. Tavily/Brave need an API key; SearXNG needs an instance URL. */
  searchProvider: WebSearchProvider;
  /** API key for the chosen search provider (Tavily/Brave). */
  searchApiKey: string;
  /** Base URL of a self-hosted SearXNG instance (used only when provider is SearXNG). */
  searxngUrl: string;
  /** Default number of search results to return (1–10). */
  maxResults: number;
  /** Default cap on characters of fetched page text returned to the model. */
  fetchCharLimit: number;
}

export interface CompactionSettings {
  /** Summarize old turns automatically as the context window fills. */
  enabled: boolean;
  /** Context fill percent (50–95) at which compaction triggers. */
  thresholdPercent: number;
}

export interface NotificationSettings {
  /** Master switch for background toasts. Errors always show regardless. */
  enabled: boolean;
  /** Notify once when session cost crosses this USD amount. 0 disables. */
  costAlertUsd: number;
  /** Hard cap: block new turns (and abort the running one) once session cost reaches this USD. 0 disables. */
  costCapUsd: number;
}

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const DEFAULT_SETTINGS: AgenticChatSettings = {
  provider: "openrouter",
  openrouterApiKey: "",
  openrouterModel: "moonshotai/kimi-k2.6",
  ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
  ollamaModel: "llama3.1",
  thinkingLevel: "off",
  temperature: 0.3,
  maxTokens: 0,
  requestTimeoutMs: 90_000,
  maxNetworkRetries: 2,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  mode: DEFAULT_MODE,
  outputStyle: DEFAULT_OUTPUT_STYLE,
  // Strongest privacy out of the box: zero data retention, no prompt
  // logging/training, and any fallback provider must also satisfy both.
  privacy: { denyDataCollection: true, requireZDR: true, allowFallbacks: true },
  approval: DEFAULT_APPROVAL_SETTINGS,
  skillsFolder: "",
  templatesFolder: "",
  agentsFolder: "",
  enableBuiltinAgents: true,
  ignoredGlobs: "",
  notifications: { enabled: true, costAlertUsd: 0, costCapUsd: 0 },
  compaction: { enabled: true, thresholdPercent: 80 },
  web: {
    enabled: false,
    searchProvider: "tavily",
    searchApiKey: "",
    searxngUrl: "",
    maxResults: 5,
    fetchCharLimit: 10_000,
  },
};

/** Merge stored settings over defaults, healing nested objects. */
export function mergeSettings(stored: Partial<AgenticChatSettings> | null | undefined): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    // Heal enum-like fields so an unknown (or retired ask/plan/agent) value can't break the gate or prompt.
    mode: healMode(stored?.mode),
    outputStyle:
      stored?.outputStyle && stored.outputStyle in OUTPUT_STYLES ? stored.outputStyle : DEFAULT_OUTPUT_STYLE,
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(stored?.privacy ?? {}) },
    approval: {
      ...DEFAULT_SETTINGS.approval,
      ...(stored?.approval ?? {}),
      perTool: { ...(stored?.approval?.perTool ?? {}) },
      // Heal the granted working dirs to a string[] so a malformed persisted value
      // can't break the gate.
      workingDirs: Array.isArray(stored?.approval?.workingDirs)
        ? stored.approval.workingDirs.filter((dir): dir is string => typeof dir === "string")
        : [],
    },
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(stored?.notifications ?? {}) },
    compaction: { ...DEFAULT_SETTINGS.compaction, ...(stored?.compaction ?? {}) },
    web: {
      ...DEFAULT_SETTINGS.web,
      ...(stored?.web ?? {}),
      // Heal the provider enum so an unknown persisted value can't break search.
      searchProvider: healSearchProvider(stored?.web?.searchProvider),
    },
  };
}

function healSearchProvider(stored: WebSearchProvider | undefined): WebSearchProvider {
  return stored && WEB_SEARCH_PROVIDERS.includes(stored) ? stored : DEFAULT_SETTINGS.web.searchProvider;
}

/** The model id used for the active provider. */
export function activeModelId(settings: AgenticChatSettings): string {
  return settings.provider === "ollama" ? settings.ollamaModel : settings.openrouterModel;
}

/** Resolve the active provider/model into a buildable model config. */
export function activeModelConfig(settings: AgenticChatSettings): ModelConfig {
  return {
    provider: settings.provider,
    modelId: activeModelId(settings),
    privacy: settings.privacy,
    ollamaBaseUrl: settings.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
  };
}

/** API key for a provider. Ollama needs no real key but the OpenAI SDK wants a non-empty string. */
export function apiKeyForProvider(settings: AgenticChatSettings, provider: string): string | undefined {
  if (provider === "ollama") return "ollama";
  return settings.openrouterApiKey.trim() || undefined;
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  ollama: "Ollama (local)",
};

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

  /** Settings grouped into virtual tabs so the page isn't one long scroll. */
  private readonly tabs: Array<{
    label: string;
    render: (containerEl: HTMLElement, settings: AgenticChatSettings) => void;
  }> = [
    { label: "Models", render: (el, settings) => this.renderModels(el, settings) },
    { label: "Agent", render: (el, settings) => this.renderAgent(el, settings) },
    { label: "Approval", render: (el, settings) => this.renderApproval(el, settings) },
    { label: "Web", render: (el, settings) => this.renderWebAccess(el, settings) },
    { label: "Notifications", render: (el, settings) => this.renderNotifications(el, settings) },
    { label: "Resources", render: (el, settings) => this.renderResources(el, settings) },
  ];
  private activeTab = 0;

  display(): void {
    const { containerEl } = this;
    const { settings } = this.plugin;
    containerEl.empty();

    if (this.activeTab < 0 || this.activeTab >= this.tabs.length) this.activeTab = 0;

    const nav = containerEl.createDiv({ cls: "agentic-chat-settings-tabs" });
    const body = containerEl.createDiv({ cls: "agentic-chat-settings-tabbody" });
    this.tabs.forEach((tab, index) => {
      const button = nav.createEl("button", { cls: "agentic-chat-settings-tab", text: tab.label });
      if (index === this.activeTab) button.addClass("is-active");
      button.addEventListener("click", () => {
        this.activeTab = index;
        this.display();
      });
    });
    this.tabs[this.activeTab].render(body, settings);
  }

  private renderModels(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    new Setting(containerEl).setName("Provider").setHeading();

    new Setting(containerEl)
      .setName("Model provider")
      .setDesc("OpenRouter for hosted models with privacy routing, or a local Ollama server.")
      .addDropdown((dropdown) => {
        for (const provider of Object.keys(PROVIDER_LABELS) as ProviderId[]) {
          dropdown.addOption(provider, PROVIDER_LABELS[provider]);
        }
        dropdown.setValue(settings.provider).onChange(async (value) => {
          settings.provider = value as ProviderId;
          await this.save();
          this.display();
        });
      });

    if (settings.provider === "openrouter") {
      this.renderOpenRouter(containerEl, settings);
    } else {
      this.renderOllama(containerEl, settings);
    }
  }

  private renderOpenRouter(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    this.renderApiKeyWarning(containerEl);
    new Setting(containerEl)
      .setName("OpenRouter API key")
      .setDesc("Create one at openrouter.ai/keys. Stored locally in this plugin's data file.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-or-…")
          .setValue(settings.openrouterApiKey)
          .onChange(async (value) => {
            settings.openrouterApiKey = value.trim();
            await this.save();
          });
      });

    new Setting(containerEl)
      .setName("Model")
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
              })
            )
              .filter((model) => model.supportsTools)
              .sort((a, b) => a.id.localeCompare(b.id));
            new ModelSuggestModal(this.app, models, (model) => {
              settings.openrouterModel = model.id;
              void this.save().then(() => this.display());
            }).open();
          } catch (error) {
            new Notice(`Agentic chat: ${error instanceof Error ? error.message : String(error)}`);
          } finally {
            button.setDisabled(false);
          }
        }),
      );

    new Setting(containerEl).setName("Privacy").setHeading();
    new Setting(containerEl)
      .setName("Deny prompt logging and training")
      .setDesc('Only route to providers that do not store or train on prompts (data policy "deny").')
      .addToggle((toggle) =>
        toggle.setValue(settings.privacy.denyDataCollection).onChange(async (value) => {
          settings.privacy.denyDataCollection = value;
          await this.save();
        }),
      );
    new Setting(containerEl)
      .setName("Require zero data retention")
      .setDesc("On by default. Only route to ZDR endpoints; some models may have no compliant provider — pick another model or use Ollama.")
      .addToggle((toggle) =>
        toggle.setValue(settings.privacy.requireZDR).onChange(async (value) => {
          settings.privacy.requireZDR = value;
          await this.save();
        }),
      );
    new Setting(containerEl)
      .setName("Allow provider fallbacks")
      .setDesc("Let OpenRouter fall back to other still-compliant providers when the preferred one is down.")
      .addToggle((toggle) =>
        toggle.setValue(settings.privacy.allowFallbacks).onChange(async (value) => {
          settings.privacy.allowFallbacks = value;
          await this.save();
        }),
      );
  }

  private renderOllama(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    new Setting(containerEl)
      .setName("Ollama server URL")
      .setDesc("Base URL of your local Ollama server. The OpenAI-compatible endpoint is derived as <url>/v1.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_OLLAMA_BASE_URL)
          .setValue(settings.ollamaBaseUrl)
          .onChange(async (value) => {
            settings.ollamaBaseUrl = value.trim() || DEFAULT_OLLAMA_BASE_URL;
            await this.save();
          }),
      );
    new Setting(containerEl)
      .setName("Model")
      .setDesc("An installed Ollama model tag, e.g. llama3.1 or qwen2.5-coder.")
      .addText((text) =>
        text
          .setPlaceholder("llama3.1")
          .setValue(settings.ollamaModel)
          .onChange(async (value) => {
            settings.ollamaModel = value.trim();
            await this.save();
          }),
      );
  }

  private renderAgent(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    new Setting(containerEl).setName("Agent").setHeading();

    new Setting(containerEl)
      .setName("Permission mode")
      .setDesc(
        "Safe honors your approval gates below; YOLO auto-approves every mutating tool for the session " +
          "(a per-tool deny still wins). Also a toggle in the chat composer. Use /plan in chat for a sticky read-only mode.",
      )
      .addDropdown((dropdown) => {
        for (const id of TOGGLE_MODES) dropdown.addOption(id, MODES[id].label);
        // Plan is entered via /plan in chat, but surface it while active so the control
        // reflects the real state — otherwise it would read "Safe" and picking Safe would
        // fire no change, trapping the user in plan mode.
        if (settings.mode === "plan") dropdown.addOption("plan", `${MODES.plan.label} (set via /plan)`);
        dropdown.setValue(settings.mode).onChange(async (value) => {
          settings.mode = value as AgentMode;
          await this.save();
        });
      });

    new Setting(containerEl)
      .setName("Thinking level")
      .setDesc("Reasoning effort for models that support it. Has no effect on models without reasoning.")
      .addDropdown((dropdown) => {
        for (const level of THINKING_LEVELS) dropdown.addOption(level, level);
        dropdown.setValue(settings.thinkingLevel).onChange(async (value) => {
          settings.thinkingLevel = value as ThinkingLevel;
          await this.save();
        });
      });

    new Setting(containerEl).setName("Temperature").addSlider((slider) =>
      slider
        .setLimits(0, 2, 0.1)
        .setValue(settings.temperature)
        .onChange(async (value) => {
          settings.temperature = value;
          await this.save();
        }),
    );

    new Setting(containerEl)
      .setName("Max response tokens")
      .setDesc("Per model request. 0 lets the provider decide.")
      .addText((text) =>
        text.setValue(String(settings.maxTokens)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.maxTokens = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName("Request timeout (seconds)")
      .setDesc("How long to wait for the provider to start responding.")
      .addText((text) =>
        text.setValue(String(Math.round(settings.requestTimeoutMs / 1000))).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.requestTimeoutMs =
            Number.isFinite(parsed) && parsed >= 5 ? parsed * 1000 : DEFAULT_SETTINGS.requestTimeoutMs;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName("Network retries")
      .setDesc("Automatic retries on rate limits and transient server errors.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 5, 1)
          .setValue(settings.maxNetworkRetries)
          .onChange(async (value) => {
            settings.maxNetworkRetries = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("System prompt")
      .setDesc("Sent at the start of every conversation.")
      .addTextArea((text) => {
        text.inputEl.rows = 10;
        text.inputEl.addClass("agentic-chat-system-prompt");
        text.setValue(settings.systemPrompt).onChange(async (value) => {
          settings.systemPrompt = value.trim() ? value : DEFAULT_SYSTEM_PROMPT;
          await this.save();
        });
      });

    new Setting(containerEl).setName("Context window").setHeading();
    new Setting(containerEl)
      .setName("Auto-compaction")
      .setDesc(
        "Summarize older turns automatically as the context window fills, so long conversations don't hit the " +
          "model limit or spike cost. The summary replaces the compacted turns in the transcript.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.compaction.enabled).onChange(async (value) => {
          settings.compaction.enabled = value;
          await this.save();
        }),
      );
    new Setting(containerEl)
      .setName("Compact at (% of context window)")
      .setDesc("Trigger compaction once the conversation fills this share of the model's context window.")
      .addSlider((slider) =>
        slider
          .setLimits(50, 95, 5)
          .setValue(settings.compaction.thresholdPercent)
          .onChange(async (value) => {
            settings.compaction.thresholdPercent = value;
            await this.save();
          }),
      );
  }

  private renderApproval(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    new Setting(containerEl).setName("Approval gates").setHeading();
    new Setting(containerEl)
      .setName("Before mutating tools")
      .setDesc("Gate write, edit, rename, and delete. Read-only tools always run (unless a working directory is set below). 'Ask' shows a confirm dialog.")
      .addDropdown((dropdown) => {
        const options: Record<ApprovalPolicy, string> = {
          allow: "Allow automatically",
          ask: "Ask each time",
          deny: "Deny (read-only mode)",
        };
        for (const [value, label] of Object.entries(options)) dropdown.addOption(value, label);
        dropdown.setValue(settings.approval.mutating).onChange(async (value) => {
          settings.approval.mutating = value as ApprovalPolicy;
          await this.save();
        });
      });

    this.renderWorkingDirs(containerEl, settings);

    new Setting(containerEl)
      .setName("Per-tool overrides")
      .setDesc("Override allow/ask/deny for individual tools. 'Default' follows the rule above (read-only tools always run).")
      .setHeading();
    for (const tool of createVaultTools(this.app)) {
      const mutating = MUTATING_TOOLS.has(tool.name);
      new Setting(containerEl)
        .setName(tool.label)
        .setDesc(`${tool.name} · ${mutating ? "mutating" : "read-only"}`)
        .addDropdown((dropdown) => {
          dropdown
            .addOption("default", "Default")
            .addOption("allow", "Allow")
            .addOption("ask", "Ask")
            .addOption("deny", "Deny")
            .setValue(settings.approval.perTool[tool.name] ?? "default")
            .onChange(async (value) => {
              if (value === "default") delete settings.approval.perTool[tool.name];
              else settings.approval.perTool[tool.name] = value as ApprovalPolicy;
              await this.save();
            });
        });
    }
  }

  /**
   * Working directories (C1/S2): an allow-list working set. When any are granted, tool
   * calls inside auto-run and calls outside route through the gate (ask) — even reads.
   */
  private renderWorkingDirs(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    new Setting(containerEl)
      .setName("Working directories")
      .setDesc(
        "Grant folders as a working set: the agent auto-runs reads/writes inside them and asks before " +
          "touching anything outside (in Safe mode). Empty keeps the vault-wide behavior above. " +
          "Ignored globs still win inside a granted folder.",
      )
      .setHeading()
      .addButton((button) =>
        button.setButtonText("Add folder").onClick(() => {
          new FolderSuggestModal(this.app, (folder) => {
            const dirs = settings.approval.workingDirs;
            // Normalize identically to the chat view + gate so entries can't diverge.
            const path = folder.path === "/" ? "" : normalizeFolderPath(folder.path);
            if (!dirs.includes(path)) {
              dirs.push(path);
              void this.save().then(() => this.display());
            }
          }).open();
        }),
      );

    if (settings.approval.workingDirs.length === 0) {
      containerEl.createDiv({
        cls: "setting-item-description",
        text: "No working directories — approval applies vault-wide.",
      });
      return;
    }
    for (const dir of settings.approval.workingDirs) {
      new Setting(containerEl)
        .setName(dir === "" ? "/ (vault root)" : dir)
        .setDesc("Auto-run inside; ask outside.")
        .addButton((button) =>
          button
            .setButtonText("Remove")
            .setClass("mod-warning")
            .onClick(async () => {
              settings.approval.workingDirs = settings.approval.workingDirs.filter((entry) => entry !== dir);
              await this.save();
              this.display();
            }),
        );
    }
  }

  private renderWebAccess(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    new Setting(containerEl).setName("Web access").setHeading();

    const warning = containerEl.createDiv({ cls: "agentic-chat-settings-warning" });
    warning.createSpan({ cls: "agentic-chat-settings-warning-icon", text: "⚠" });
    warning.createSpan({
      text:
        "Web search and fetch send your query text and the URLs the agent opens to a third-party " +
        "service, off-device — outside the vault's privacy boundary. Off by default; turn it on only " +
        "when you want the agent to use the open web.",
    });

    new Setting(containerEl)
      .setName("Enable web search & fetch")
      .setDesc("Give the agent web_search and fetch_url tools. When off, the agent cannot reach the network at all.")
      .addToggle((toggle) =>
        toggle.setValue(settings.web.enabled).onChange(async (value) => {
          settings.web.enabled = value;
          await this.save();
          this.display();
        }),
      );

    if (!settings.web.enabled) return;

    new Setting(containerEl)
      .setName("Search provider")
      .setDesc("Backend for web_search. Tavily and Brave need an API key; SearXNG needs a self-hosted instance URL.")
      .addDropdown((dropdown) => {
        for (const provider of WEB_SEARCH_PROVIDERS) {
          dropdown.addOption(provider, WEB_SEARCH_PROVIDER_LABELS[provider]);
        }
        dropdown.setValue(settings.web.searchProvider).onChange(async (value) => {
          settings.web.searchProvider = value as WebSearchProvider;
          await this.save();
          this.display();
        });
      });

    if (settings.web.searchProvider === "searxng") {
      new Setting(containerEl)
        .setName("SearXNG instance URL")
        .setDesc("Base URL of your SearXNG instance, e.g. https://searx.example.com. The JSON API must be enabled.")
        .addText((text) =>
          text
            .setPlaceholder("https://searx.example.com")
            .setValue(settings.web.searxngUrl)
            .onChange(async (value) => {
              settings.web.searxngUrl = value.trim();
              await this.save();
            }),
        );
    } else {
      new Setting(containerEl)
        .setName("Search API key")
        .setDesc(
          settings.web.searchProvider === "tavily"
            ? "Tavily API key (tavily.com). Stored in plaintext like your model key."
            : "Brave Search API key (brave.com/search/api). Stored in plaintext like your model key.",
        )
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder(settings.web.searchProvider === "tavily" ? "tvly-…" : "BSA…")
            .setValue(settings.web.searchApiKey)
            .onChange(async (value) => {
              settings.web.searchApiKey = value.trim();
              await this.save();
            });
        });
    }

    new Setting(containerEl)
      .setName("Search results")
      .setDesc("How many results web_search returns by default.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 10, 1)
          .setValue(settings.web.maxResults)
          .onChange(async (value) => {
            settings.web.maxResults = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Fetched page character limit")
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
  }

  /** Warn that API keys live in plaintext inside the vault's plugin data file. */
  private renderApiKeyWarning(containerEl: HTMLElement): void {
    const warning = containerEl.createDiv({ cls: "agentic-chat-settings-warning" });
    warning.createSpan({ cls: "agentic-chat-settings-warning-icon", text: "⚠" });
    warning.createSpan({
      text:
        "Your API key is stored in plaintext in this plugin's data.json inside the vault. " +
        "If you sync or share the vault, the key goes with it — treat it like a password and " +
        "rotate it at openrouter.ai/keys if the vault is ever exposed.",
    });
  }

  private renderNotifications(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    new Setting(containerEl).setName("Notifications").setHeading();
    new Setting(containerEl)
      .setName("Background notifications")
      .setDesc("Show toasts for background signals (agent finished while you're elsewhere, context window filling, cost cap). Errors always show.")
      .addToggle((toggle) =>
        toggle.setValue(settings.notifications.enabled).onChange(async (value) => {
          settings.notifications.enabled = value;
          await this.save();
        }),
      );
    new Setting(containerEl)
      .setName("Cost alert (USD)")
      .setDesc("Notify once when a conversation's cost crosses this amount. 0 disables.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.setAttribute("min", "0");
        text.inputEl.setAttribute("step", "any");
        text.setValue(String(settings.notifications.costAlertUsd)).onChange(async (value) => {
          const parsed = Number.parseFloat(value);
          settings.notifications.costAlertUsd = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
          await this.save();
        });
      });
    new Setting(containerEl)
      .setName("Hard spend cap (USD)")
      .setDesc(
        "Block new turns — and stop a turn already running — once this conversation's cost reaches this amount. " +
          "0 disables. Applies only to models with known pricing.",
      )
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.setAttribute("min", "0");
        text.inputEl.setAttribute("step", "any");
        text.setValue(String(settings.notifications.costCapUsd)).onChange(async (value) => {
          const parsed = Number.parseFloat(value);
          settings.notifications.costCapUsd = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
          await this.save();
        });
      });
  }

  private renderResources(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    new Setting(containerEl).setName("Skills & templates").setHeading();

    this.folderSetting(
      containerEl,
      "Skills folder",
      "Vault folder scanned for SKILL.md files (skills and personas). Leave empty to disable.",
      settings.skillsFolder,
      async (value) => {
        settings.skillsFolder = value;
        await this.save();
      },
    );

    this.folderSetting(
      containerEl,
      "Prompt templates folder (deprecated)",
      "Deprecated: templates are now skills. Files here load as skills and run via /skill " +
        "(with $ARGUMENTS/$1 support). Move them into the skills folder; this setting will be removed.",
      settings.templatesFolder,
      async (value) => {
        settings.templatesFolder = value;
        await this.save();
      },
    );

    new Setting(containerEl).setName("Subagents").setHeading();
    new Setting(containerEl)
      .setName("Built-in subagents")
      .setDesc("Offer the built-in researcher, reviewer, and editor subagents for delegation.")
      .addToggle((toggle) =>
        toggle.setValue(settings.enableBuiltinAgents).onChange(async (value) => {
          settings.enableBuiltinAgents = value;
          await this.save();
        }),
      );
    this.folderSetting(
      containerEl,
      "Subagents folder",
      "Vault folder scanned for AGENT.md profiles (frontmatter: name, description, model, tools). " +
        "A vault profile overrides a built-in of the same name. Leave empty for built-ins only.",
      settings.agentsFolder,
      async (value) => {
        settings.agentsFolder = value;
        await this.save();
      },
    );

    new Setting(containerEl).setName("Ignored files").setHeading();
    new Setting(containerEl)
      .setName("Ignore list")
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
  }

  private folderSetting(
    containerEl: HTMLElement,
    name: string,
    desc: string,
    value: string,
    onChange: (value: string) => Promise<void>,
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.setPlaceholder("(none)").setValue(value).onChange((next) => void onChange(next.trim()));
        text.inputEl.addClass("agentic-chat-folder-input");
        this.folderInputs.set(name, text.inputEl);
      })
      .addButton((button) =>
        button.setButtonText("Browse").onClick(() => {
          new FolderSuggestModal(this.app, (folder) => {
            const path = folder.path === "/" ? "" : folder.path;
            void onChange(path);
            const input = this.folderInputs.get(name);
            if (input) input.value = path;
          }).open();
        }),
      );
  }

  private readonly folderInputs = new Map<string, HTMLInputElement>();
}
