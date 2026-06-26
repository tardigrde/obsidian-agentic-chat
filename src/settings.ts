import { App, Notice, PluginSettingTab, Setting, type ButtonComponent } from "obsidian";
import { normalizeFolderPath } from "./vault/path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type AgenticChatPlugin from "./main";
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
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
import { MUTATING_TOOLS } from "./tools/tool-contracts";
import { createVaultTools } from "./tools/vault-tools";
import {
  createMcpServerSettings,
  healMcpSettings,
  nextUniqueMcpServerId,
  normalizeMcpServerId,
  normalizeMcpNoProxy,
  normalizeMcpProxyUrl,
  resetMcpCredentials,
  resetMcpServerSecretRefs,
  serverIdFromMcpUrl,
  type McpKnownToolSettings,
  type McpAuthType,
  type McpServerSettings,
  type McpSettings,
} from "./mcp/settings";
import {
  authenticateMcpServer,
  clearMcpOAuth,
  DEFAULT_MCP_OAUTH_REDIRECT_URI,
  hasMcpOAuthAccess,
  type McpOAuthProgressEvent,
} from "./mcp/oauth";
import { createFetchFromWebFetcher, createMcpFetcher, createProxiedFetcher } from "./mcp/fetcher";
import { localMcpToolName, localMcpToolNames, probeMcpServer } from "./mcp/tools";
import { isValidHttpHeaderName } from "./mcp/http-headers";
import {
  WEB_SEARCH_PROVIDER_LABELS,
  WEB_SEARCH_PROVIDERS,
  type WebSearchProvider,
} from "./tools/web-search";
import { FolderSuggestModal } from "./ui/folder-suggest";
import { ModelSuggestModal } from "./ui/model-suggest-modal";
import {
  OPENAI_COMPATIBLE_API_KEY_SECRET_ID,
  OPENROUTER_API_KEY_SECRET_ID,
  WEB_SEARCH_API_KEY_SECRET_ID,
} from "./secrets/secret-store";

export interface AgenticChatSettings {
  provider: ProviderId;
  /** Secret id in Obsidian secretStorage. */
  openrouterApiKeySecretId: string;
  /** Deprecated plaintext migration/fallback field. Persisted as empty after save. */
  openrouterApiKey: string;
  openrouterModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  openaiCompatibleBaseUrl: string;
  /** Secret id in Obsidian secretStorage. */
  openaiCompatibleApiKeySecretId: string;
  /** Deprecated plaintext migration/fallback field. Persisted as empty after save. */
  openaiCompatibleApiKey: string;
  openaiCompatibleModel: string;
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
  /** Optional plugin-owned HTTP proxy for request paths the plugin controls. */
  network: NetworkSettings;
  /** Open-web access: search + fetch tools. Off by default — sends data off-device. */
  web: WebSettings;
  /** Remote MCP tools over HTTPS Streamable HTTP. Off by default — sends data off-device. */
  mcp: McpSettings;
}

export interface NetworkSettings {
  /** Optional HTTP proxy URL used by plugin-owned request paths. */
  proxyUrl: string;
  /** Comma-separated hosts/domains that bypass the plugin proxy. */
  noProxy: string;
}

export interface WebSettings {
  /**
   * Master egress gate for web search + fetch. Off by default. When off the web
   * tools are not registered at all, so the agent cannot reach the network.
   */
  enabled: boolean;
  /** Search backend. Tavily/Brave need an API key; SearXNG needs an instance URL. */
  searchProvider: WebSearchProvider;
  /** Secret id in Obsidian secretStorage. */
  searchApiKeySecretId: string;
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
  openrouterApiKeySecretId: OPENROUTER_API_KEY_SECRET_ID,
  openrouterApiKey: "",
  openrouterModel: "moonshotai/kimi-k2.6",
  ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
  ollamaModel: "llama3.1",
  openaiCompatibleBaseUrl: DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  openaiCompatibleApiKeySecretId: OPENAI_COMPATIBLE_API_KEY_SECRET_ID,
  openaiCompatibleApiKey: "",
  openaiCompatibleModel: "",
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
  network: {
    proxyUrl: "",
    noProxy: "localhost,127.0.0.1,::1",
  },
  web: {
    enabled: false,
    searchProvider: "tavily",
    searchApiKeySecretId: WEB_SEARCH_API_KEY_SECRET_ID,
    searchApiKey: "",
    searxngUrl: "",
    maxResults: 5,
    fetchCharLimit: 10_000,
  },
  mcp: {
    enabled: false,
    proxyUrl: "",
    noProxy: "localhost,127.0.0.1,::1",
    servers: [],
  },
};

/** Merge stored settings over defaults, healing nested objects. */
export function mergeSettings(stored: Partial<AgenticChatSettings> | null | undefined): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    // Heal enum-like fields so an unknown (or retired ask/plan/agent) value can't break the gate or prompt.
    provider: healProvider(stored?.provider),
    openrouterApiKeySecretId: stringSetting(stored?.openrouterApiKeySecretId, OPENROUTER_API_KEY_SECRET_ID),
    openaiCompatibleApiKeySecretId: stringSetting(
      stored?.openaiCompatibleApiKeySecretId,
      OPENAI_COMPATIBLE_API_KEY_SECRET_ID,
    ),
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
    network: healNetworkSettings(stored?.network),
    web: {
      ...DEFAULT_SETTINGS.web,
      ...(stored?.web ?? {}),
      // Heal the provider enum so an unknown persisted value can't break search.
      searchProvider: healSearchProvider(stored?.web?.searchProvider),
      searchApiKeySecretId: stringSetting(stored?.web?.searchApiKeySecretId, WEB_SEARCH_API_KEY_SECRET_ID),
    },
    mcp: healMcpSettings(stored?.mcp),
  };
}

function stringSetting(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function healNetworkSettings(stored: Partial<NetworkSettings> | null | undefined): NetworkSettings {
  return {
    proxyUrl: normalizeMcpProxyUrl(stored?.proxyUrl),
    noProxy: normalizeMcpNoProxy(stored?.noProxy),
  };
}

function healSearchProvider(stored: WebSearchProvider | undefined): WebSearchProvider {
  return stored && WEB_SEARCH_PROVIDERS.includes(stored) ? stored : DEFAULT_SETTINGS.web.searchProvider;
}

function healProvider(stored: ProviderId | undefined): ProviderId {
  return stored && PROVIDERS.includes(stored) ? stored : DEFAULT_SETTINGS.provider;
}

/** The model id used for the active provider. */
export function activeModelId(settings: AgenticChatSettings): string {
  if (settings.provider === "ollama") return settings.ollamaModel;
  if (settings.provider === "openai-compatible") return settings.openaiCompatibleModel;
  return settings.openrouterModel;
}

/** Resolve the active provider/model into a buildable model config. */
export function activeModelConfig(settings: AgenticChatSettings): ModelConfig {
  return {
    provider: settings.provider,
    modelId: activeModelId(settings),
    privacy: settings.privacy,
    ollamaBaseUrl: settings.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL,
    openaiCompatibleBaseUrl: settings.openaiCompatibleBaseUrl || DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  };
}

/** API key for a provider. Ollama needs no real key but the OpenAI SDK wants a non-empty string. */
export function apiKeyForProvider(settings: AgenticChatSettings, provider: string): string | undefined {
  if (provider === "ollama") return "ollama";
  if (provider === "openai-compatible") return settings.openaiCompatibleApiKey.trim() || undefined;
  return settings.openrouterApiKey.trim() || undefined;
}

const PROVIDERS: ProviderId[] = ["openrouter", "ollama", "openai-compatible"];

const PROVIDER_LABELS: Record<ProviderId, string> = {
  openrouter: "OpenRouter",
  ollama: "Ollama (local)",
  "openai-compatible": "OpenAI-compatible",
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

  /** Settings grouped into virtual tabs so the page isn't one long scroll. */
  private readonly tabs: Array<{
    label: string;
    render: (containerEl: HTMLElement, settings: AgenticChatSettings) => void;
  }> = [
    { label: "Models", render: (el, settings) => this.renderModels(el, settings) },
    { label: "Agent", render: (el, settings) => this.renderAgent(el, settings) },
    { label: "Approval", render: (el, settings) => this.renderApproval(el, settings) },
    { label: "Web", render: (el, settings) => this.renderWebAccess(el, settings) },
    { label: "MCP", render: (el, settings) => this.renderMcp(el, settings) },
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
      .setDesc("OpenRouter with privacy routing, local Ollama, or any OpenAI-compatible gateway.")
      .addDropdown((dropdown) => {
        for (const provider of PROVIDERS) {
          dropdown.addOption(provider, PROVIDER_LABELS[provider]);
        }
        dropdown.setValue(settings.provider).onChange(async (value) => {
          settings.provider = value as ProviderId;
          await this.save();
          this.display();
        });
      });

    new Setting(containerEl).setName("Network proxy").setHeading();

    new Setting(containerEl)
      .setName("HTTP proxy")
      .setDesc(
        "Optional HTTP proxy for plugin-owned network calls: OpenRouter/OpenAI-compatible chat, model browsing, web tools, and MCP unless MCP overrides it.",
      )
      .addText((text) =>
        text
          .setPlaceholder("http://10.36.148.11:3128")
          .setValue(settings.network.proxyUrl)
          .onChange(async (value) => {
            settings.network.proxyUrl = value.trim();
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("No proxy")
      .setDesc("Comma-separated hosts/domains that bypass the plugin proxy.")
      .addText((text) =>
        text
          .setPlaceholder("localhost,127.0.0.1,::1")
          .setValue(settings.network.noProxy)
          .onChange(async (value) => {
            settings.network.noProxy = value.trim();
            await this.save();
          }),
      );

    if (settings.provider === "openrouter") {
      this.renderOpenRouter(containerEl, settings);
    } else if (settings.provider === "openai-compatible") {
      this.renderOpenAICompatible(containerEl, settings);
    } else {
      this.renderOllama(containerEl, settings);
    }
  }

  private renderOpenRouter(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    this.renderApiKeyWarning(containerEl);
    this.renderSecretInput(containerEl, {
      name: "OpenRouter API key",
      desc: "Create one at openrouter.ai/keys.",
      placeholder: "sk-or-...",
      hasValue: Boolean(settings.openrouterApiKey),
      onSet: async (value) => {
        settings.openrouterApiKey = value;
        await this.save();
      },
      onForget: async () => {
        settings.openrouterApiKey = "";
        await this.save();
      },
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
                fetchImpl: createFetchFromWebFetcher(createProxiedFetcher(settings.network)),
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

  private renderOpenAICompatible(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    this.renderApiKeyWarning(containerEl);
    const activePreset = openAICompatiblePresetForBaseUrl(settings.openaiCompatibleBaseUrl);
    new Setting(containerEl)
      .setName("Gateway preset")
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
          this.display();
        });
      });
    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("Base URL for an OpenAI chat-completions compatible gateway. For OpenWebUI, use its /api base URL.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_OPENAI_COMPATIBLE_BASE_URL)
          .setValue(settings.openaiCompatibleBaseUrl)
          .onChange(async (value) => {
            settings.openaiCompatibleBaseUrl = value.trim() || DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
            await this.save();
          }),
      );
    this.renderSecretInput(containerEl, {
      name: "API key",
      desc: "Bearer token for the configured OpenAI-compatible gateway.",
      placeholder: activePreset?.apiKeyPlaceholder ?? "sk-...",
      hasValue: Boolean(settings.openaiCompatibleApiKey),
      onSet: async (value) => {
        settings.openaiCompatibleApiKey = value;
        await this.save();
      },
      onForget: async () => {
        settings.openaiCompatibleApiKey = "";
        await this.save();
      },
    });
    new Setting(containerEl)
      .setName("Model")
      .setDesc("Model id exposed by the configured gateway.")
      .addText((text) =>
        text
          .setPlaceholder(activePreset?.modelPlaceholder ?? "qwen2.5-coder")
          .setValue(settings.openaiCompatibleModel)
          .onChange(async (value) => {
            settings.openaiCompatibleModel = value.trim();
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

    new Setting(containerEl)
      .setName("Standing instructions")
      .setDesc(
        "The agent loads AGENTS.md from the vault root every turn as standing context " +
          "(falls back to CLAUDE.md, then GEMINI.md, if AGENTS.md is absent — symlink them for other agents). " +
          "Edit the file directly, or run /init to have the agent curate it.",
      );

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
      .setDesc("Gate tools that change the vault. Read-only tools always run (unless a working directory is set below). 'Ask' shows a confirm dialog.")
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
      this.renderSecretInput(containerEl, {
        name: "Search API key",
        desc:
          settings.web.searchProvider === "tavily"
            ? "Tavily API key (tavily.com)."
            : "Brave Search API key (brave.com/search/api).",
        placeholder: settings.web.searchProvider === "tavily" ? "tvly-..." : "BSA...",
        hasValue: Boolean(settings.web.searchApiKey),
        onSet: async (value) => {
          settings.web.searchApiKey = value;
          await this.save();
        },
        onForget: async () => {
          settings.web.searchApiKey = "";
          await this.save();
        },
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

  private renderMcp(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    new Setting(containerEl).setName("MCP tools").setHeading();

    const warning = containerEl.createDiv({ cls: "agentic-chat-settings-warning" });
    warning.createSpan({ cls: "agentic-chat-settings-warning-icon", text: "⚠" });
    warning.createSpan({
      text:
        "MCP tools send tool names and arguments to configured remote MCP servers. Only HTTPS " +
        "Streamable HTTP endpoints are supported; stdio and subprocess servers are intentionally unsupported.",
    });

    new Setting(containerEl)
      .setName("Enable MCP")
      .setDesc("Discover and register tools from configured HTTPS MCP servers.")
      .addToggle((toggle) =>
        toggle.setValue(settings.mcp.enabled).onChange(async (value) => {
          settings.mcp.enabled = value;
          await this.save();
          this.display();
        }),
      );

    if (!settings.mcp.enabled) return;

    new Setting(containerEl)
      .setName("HTTP proxy")
      .setDesc("Optional MCP-only override. Leave empty to inherit the global network proxy from the Models tab.")
      .addText((text) =>
        text
          .setPlaceholder("http://host:port")
          .setValue(settings.mcp.proxyUrl)
          .onChange(async (value) => {
            settings.mcp.proxyUrl = value.trim();
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("No proxy")
      .setDesc("Comma-separated hosts/domains that bypass the MCP proxy.")
      .addText((text) =>
        text
          .setPlaceholder("localhost,127.0.0.1,::1")
          .setValue(settings.mcp.noProxy)
          .onChange(async (value) => {
            settings.mcp.noProxy = value.trim();
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Servers")
      .setDesc("Add HTTPS Streamable HTTP servers, choose authentication, then test discovery.")
      .setHeading()
      .addButton((button) =>
        button.setButtonText("Add server").onClick(async () => {
          const id = this.nextMcpServerId(settings, "mcp");
          this.upsertMcpServer(settings, createMcpServerSettings({ id }));
          await this.save();
          this.display();
        }),
      );

    if (settings.mcp.servers.length === 0) {
      containerEl.createDiv({
        cls: "setting-item-description",
        text: "No MCP servers configured. Add a server, paste its HTTPS endpoint, choose auth, then test connection to discover tools.",
      });
      return;
    }

    for (const server of settings.mcp.servers) {
      this.renderMcpServer(containerEl, settings, server);
    }
  }

  private renderMcpServer(
    containerEl: HTMLElement,
    settings: AgenticChatSettings,
    server: McpServerSettings,
  ): void {
    const endpointProblem = this.mcpEndpointProblem(server.url);
    let testButton: ButtonComponent | undefined;
    const syncTestButton = (): void => {
      if (!testButton) return;
      const state = this.mcpTestButtonState(server);
      testButton.setButtonText(state.label).setDisabled(Boolean(state.problem));
    };
    const header = new Setting(containerEl)
      .setName(server.name || server.id)
      .setDesc(this.formatMcpServerSummary(server, endpointProblem))
      .setHeading()
      .addToggle((toggle) =>
        toggle.setValue(server.enabled).onChange(async (value) => {
          server.enabled = value;
          await this.save();
        }),
      )
      .addButton((button) => {
        testButton = button;
        syncTestButton();
        return button
          .onClick(async () => {
            const state = this.mcpTestButtonState(server);
            if (state.problem) {
              new Notice(state.problem);
              syncTestButton();
              return;
            }
            await this.runMcpButtonAction(
              button,
              state.label,
              state.busyLabel,
              () => state.needsOAuthSignIn ? this.authenticateAndProbeMcpServer(server) : this.testMcpServer(server),
            );
            syncTestButton();
          });
      });

    if (server.authType === "oauth") {
      header.addButton((button) =>
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

    header.addButton((button) =>
      button
        .setButtonText("Remove")
        .setClass("mod-warning")
        .onClick(async () => {
          this.deleteMcpPerToolApprovals(settings, server.id);
          this.clearMcpSecretSlots(server);
          settings.mcp.servers = settings.mcp.servers.filter((entry) => entry !== server);
          await this.save();
          this.display();
        }),
    );

    new Setting(containerEl)
      .setName("Name")
      .setDesc("Shown in tool labels and approval prompts.")
      .addText((text) =>
        text.setValue(server.name).onChange(async (value) => {
          server.name = value.trim() || server.id;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName("Server id")
      .setDesc("Advanced. Used in local tool names: mcp__<id>__<tool>.")
      .addText((text) =>
        text.setValue(server.id).onChange(async (value) => {
          const next = normalizeMcpServerId(value);
          this.renameMcpServer(settings, server, this.nextMcpServerId(settings, next, server));
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName("HTTPS endpoint")
      .setDesc(endpointProblem || "Streamable HTTP endpoint. Query parameters are preserved.")
      .addText((text) =>
        text
          .setPlaceholder("https://mcp.example.com/mcp")
          .setValue(server.url)
          .onChange(async (value) => {
            const result = this.updateMcpServerEndpoint(settings, server, value);
            await this.save();
            if (result.clearedCredentials) new Notice(`${server.name}: cleared MCP credentials for the changed endpoint.`);
            if (result.shouldDisplay) this.display();
          }),
      );

    new Setting(containerEl)
      .setName("Approval")
      .setDesc("Gate every tool call from this server.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ask", "Ask each time")
          .addOption("allow", "Allow automatically")
          .addOption("deny", "Deny")
          .setValue(server.approval)
          .onChange(async (value) => {
            server.approval = value as ApprovalPolicy;
            await this.save();
          }),
      );

    this.renderMcpAuthentication(containerEl, server, syncTestButton);
    this.renderMcpToolApprovals(containerEl, settings, server);
  }

  private renderMcpToolApprovals(
    containerEl: HTMLElement,
    settings: AgenticChatSettings,
    server: McpServerSettings,
  ): void {
    new Setting(containerEl)
      .setName("Tool approvals")
      .setDesc("Per-tool overrides for the last discovered tools. Default follows this server's approval policy.")
      .setHeading()
      .addButton((button) =>
        button.setButtonText("Refresh tools").onClick(async () => {
          await this.refreshMcpKnownTools(server, button);
        }),
      );

    if (server.knownTools.length === 0) {
      containerEl.createDiv({
        cls: "setting-item-description",
        text: "No discovered tools cached yet. Use Refresh tools, Test connection, or Authenticate & test.",
      });
      return;
    }

    for (const tool of [...server.knownTools].sort((a, b) => a.name.localeCompare(b.name))) {
      const localName = this.mcpKnownToolLocalName(server, tool);
      const title = tool.title && tool.title !== tool.name ? `${tool.title} (${tool.name})` : tool.name;
      new Setting(containerEl)
        .setName(title)
        .setDesc(this.formatMcpToolApprovalDescription(localName, tool))
        .addDropdown((dropdown) =>
          dropdown
            .addOption("default", `Default (${server.approval})`)
            .addOption("allow", "Allow")
            .addOption("ask", "Ask")
            .addOption("deny", "Deny")
            .setValue(settings.approval.perTool[localName] ?? "default")
            .onChange(async (value) => {
              if (value === "default") delete settings.approval.perTool[localName];
              else settings.approval.perTool[localName] = value as ApprovalPolicy;
              await this.save();
            }),
        );
    }
  }

  private formatMcpToolApprovalDescription(localName: string, tool: McpKnownToolSettings): string {
    return `${localName}${tool.readOnlyHint ? " · read-only hint" : ""}`;
  }

  private formatMcpServerSummary(server: McpServerSettings, endpointProblem: string): string {
    const status = server.enabled ? "enabled" : "disabled";
    const auth = this.formatMcpAuthType(server);
    const tools =
      server.knownTools.length > 0
        ? `${server.knownTools.length} discovered tool${server.knownTools.length === 1 ? "" : "s"}`
        : "no tools discovered yet";
    const endpoint = endpointProblem || server.url || "No endpoint configured";
    return `${endpoint} · ${status} · ${auth} · ${tools}`;
  }

  private formatMcpAuthType(server: McpServerSettings): string {
    if (server.authType === "none") return "no auth";
    if (server.authType === "bearer") return server.authHeaderValue ? "bearer token set" : "bearer token missing";
    if (server.authType === "header") {
      return server.authHeaderName && server.authHeaderValue ? `header ${server.authHeaderName}` : "static header incomplete";
    }
    return hasMcpOAuthAccess(server) ? "OAuth authenticated" : "OAuth not authenticated";
  }

  private mcpEndpointProblem(url: string): string {
    const trimmed = url.trim();
    if (!trimmed || trimmed === "https://") return "Paste an HTTPS Streamable HTTP endpoint.";
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:") return "MCP server URLs must use https://.";
      return "";
    } catch {
      return "Enter a valid HTTPS MCP server URL.";
    }
  }

  private mcpTestButtonState(server: McpServerSettings): {
    label: string;
    busyLabel: string;
    problem: string;
    needsOAuthSignIn: boolean;
  } {
    const needsOAuthSignIn = server.authType === "oauth" && !hasMcpOAuthAccess(server);
    const problem = this.mcpEndpointProblem(server.url) || (needsOAuthSignIn ? "" : this.mcpAuthProblem(server));
    return {
      label: needsOAuthSignIn ? "Authenticate & test" : "Test connection",
      busyLabel: needsOAuthSignIn ? "Authenticating..." : "Testing...",
      problem,
      needsOAuthSignIn,
    };
  }

  private renderMcpAuthentication(
    containerEl: HTMLElement,
    server: McpServerSettings,
    onAuthChanged: () => void,
  ): void {
    const authProblem = this.mcpAuthProblem(server);
    new Setting(containerEl)
      .setName("Authentication")
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
            await this.save();
            this.display();
          }),
      );

    if (server.authType === "oauth") {
      this.renderMcpOAuth(containerEl, server);
      return;
    }

    if (server.authType === "bearer") {
      this.renderSecretInput(containerEl, {
        name: "Bearer token",
        desc: 'Paste the token only. If you include "Bearer", Agentic Chat will not add it twice.',
        placeholder: "token",
        hasValue: Boolean(server.authHeaderValue),
        onSet: async (value) => {
          server.authHeaderValue = value;
          await this.save();
          onAuthChanged();
        },
        onForget: async () => {
          server.authHeaderValue = "";
          await this.save();
          onAuthChanged();
        },
      });
      return;
    }

    if (server.authType !== "header") return;

    new Setting(containerEl)
      .setName("Auth header")
      .setDesc("Header name sent with every MCP request.")
      .addText((text) =>
        text
          .setPlaceholder("X-API-Key")
          .setValue(server.authHeaderName)
          .onChange(async (value) => {
            server.authHeaderName = value.trim();
            await this.save();
            onAuthChanged();
          }),
      );

    this.renderSecretInput(containerEl, {
      name: "Auth value",
      desc: "Header value sent with every MCP request.",
      placeholder: "secret header value",
      hasValue: Boolean(server.authHeaderValue),
      onSet: async (value) => {
        server.authHeaderValue = value;
        await this.save();
        onAuthChanged();
      },
      onForget: async () => {
        server.authHeaderValue = "";
        await this.save();
        onAuthChanged();
      },
    });
  }

  private renderMcpOAuth(containerEl: HTMLElement, server: McpServerSettings): void {
    const authenticated = hasMcpOAuthAccess(server);
    new Setting(containerEl)
      .setName("OAuth status")
      .setDesc(
        authenticated
          ? `Authenticated${server.oauth.scope ? ` with scopes: ${server.oauth.scope}` : ""}.`
          : "Not authenticated. Use the Authenticate & test button in this server's header.",
      )
      .addButton((button) =>
        button
          .setButtonText("Forget token")
          .setDisabled(!server.oauth.accessToken && !server.oauth.refreshToken)
          .onClick(async () => {
            clearMcpOAuth(server);
            await this.save();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("OAuth redirect URI")
      .setDesc("Register this URI with MCP OAuth servers that require a manual client setup.")
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

    new Setting(containerEl)
      .setName("OAuth client id")
      .setDesc("Optional. Leave empty to use dynamic client registration when the server supports it.")
      .addText((text) =>
        text.setValue(server.oauth.clientId).onChange(async (value) => {
          server.oauth.clientId = value.trim();
          server.oauth.dynamicClientRegistration = false;
          server.oauth.registeredRedirectUri = "";
          await this.save();
        }),
      );

    this.renderSecretInput(containerEl, {
      name: "OAuth client secret",
      desc: "Optional. Most MCP OAuth servers use public clients with PKCE and no secret.",
      placeholder: "client secret",
      hasValue: Boolean(server.oauth.clientSecret),
      onSet: async (value) => {
        server.oauth.clientSecret = value;
        server.oauth.dynamicClientRegistration = false;
        server.oauth.registeredRedirectUri = "";
        await this.save();
      },
      onForget: async () => {
        server.oauth.clientSecret = "";
        server.oauth.dynamicClientRegistration = false;
        server.oauth.registeredRedirectUri = "";
        await this.save();
      },
    });
  }

  private formatMcpToolSample(toolNames: string[]): string {
    const sample = toolNames.slice(0, 5).join(", ");
    return sample ? ` (${sample})` : "";
  }

  private async refreshMcpKnownTools(server: McpServerSettings, button?: ButtonComponent): Promise<void> {
    button?.setDisabled(true);
    try {
      const result = await this.probeAndCacheMcpTools(server);
      const sample = this.formatMcpToolSample(result.toolNames);
      new Notice(
        `${server.name}: refreshed ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}${sample}.`,
      );
      this.display();
    } catch (error) {
      new Notice(`Agentic chat: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      button?.setDisabled(false);
    }
  }

  private async probeAndCacheMcpTools(server: McpServerSettings): Promise<Awaited<ReturnType<typeof probeMcpServer>>> {
    const endpointProblem = this.mcpEndpointProblem(server.url);
    if (endpointProblem) throw new Error(endpointProblem);
    const result = await probeMcpServer(server, createMcpFetcher(this.effectiveMcpProxySettings()), {
      onServerChanged: () => this.save(),
    });
    server.knownTools = result.tools;
    server.enabled = true;
    await this.save();
    return result;
  }

  private async testMcpServer(server: McpServerSettings): Promise<void> {
    const result = await this.probeAndCacheMcpTools(server);
    const sample = this.formatMcpToolSample(result.toolNames);
    new Notice(
      `${server.name}: connected; discovered ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}${sample}.`,
    );
    this.display();
  }

  private async authenticateAndProbeMcpServer(server: McpServerSettings): Promise<void> {
    const fetcher = createMcpFetcher(this.effectiveMcpProxySettings());
    await authenticateMcpServer(server, fetcher, {
      onProgress: (event) => this.handleMcpOAuthProgress(server, event),
    });
    const result = await probeMcpServer(server, fetcher, {
      onServerChanged: () => this.save(),
    });
    server.knownTools = result.tools;
    await this.save();
    const sample = this.formatMcpToolSample(result.toolNames);
    new Notice(
      `Authenticated ${server.name}; discovered ${result.toolCount} tool${
        result.toolCount === 1 ? "" : "s"
      }${sample}.`,
    );
    this.display();
  }

  private effectiveMcpProxySettings(): NetworkSettings {
    const { network, mcp } = this.plugin.settings;
    return mcp.proxyUrl ? { proxyUrl: mcp.proxyUrl, noProxy: mcp.noProxy } : network;
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
      new Notice(`Agentic Chat MCP: ${error instanceof Error ? error.message : String(error)}`);
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

  private upsertMcpServer(settings: AgenticChatSettings, server: McpServerSettings): void {
    const existing = settings.mcp.servers.find((entry) => entry.id === server.id);
    if (existing) {
      const oauth = { ...server.oauth, ...existing.oauth };
      oauth.clientSecretSecretId ||= server.oauth.clientSecretSecretId;
      oauth.accessTokenSecretId ||= server.oauth.accessTokenSecretId;
      oauth.refreshTokenSecretId ||= server.oauth.refreshTokenSecretId;
      Object.assign(existing, server, {
        authHeaderValueSecretId: existing.authHeaderValueSecretId || server.authHeaderValueSecretId,
        authHeaderValue: existing.authHeaderValue,
        oauth,
      });
    } else {
      settings.mcp.servers.push(server);
    }
  }

  private nextMcpServerId(
    settings: AgenticChatSettings,
    base: string,
    current?: McpServerSettings,
  ): string {
    const used = new Set(settings.mcp.servers.filter((entry) => entry !== current).map((entry) => entry.id));
    return nextUniqueMcpServerId(base, used);
  }

  private updateMcpServerEndpoint(
    settings: AgenticChatSettings,
    server: McpServerSettings,
    value: string,
  ): { clearedCredentials: boolean; shouldDisplay: boolean } {
    const previousUrl = server.url;
    const previousId = server.id;
    const previousEndpointProblem = this.mcpEndpointProblem(previousUrl);
    const wasEnabled = server.enabled;
    server.url = value.trim();
    const suggestedId = serverIdFromMcpUrl(server.url);
    if (suggestedId && previousId === "mcp" && (!previousUrl || previousUrl === "https://")) {
      this.renameMcpServer(settings, server, this.nextMcpServerId(settings, suggestedId, server));
    }
    let clearedCredentials = false;
    if (previousUrl.trim() !== server.url.trim()) {
      this.clearMcpKnownToolsAndApprovals(settings, server);
      if (this.mcpCredentialResourceChanged(previousUrl, server.url)) {
        resetMcpCredentials(server);
        clearedCredentials = true;
      }
    }
    if (!this.mcpEndpointProblem(server.url)) server.enabled = true;
    return {
      clearedCredentials,
      shouldDisplay:
        Boolean(previousEndpointProblem) !== Boolean(this.mcpEndpointProblem(server.url)) ||
        wasEnabled !== server.enabled ||
        previousId !== server.id,
    };
  }

  private renameMcpServer(settings: AgenticChatSettings, server: McpServerSettings, nextId: string): void {
    const previousId = server.id;
    if (previousId === nextId) return;
    const previousSecretIds = this.mcpSecretIds(server);
    const previousApprovals = this.deleteMcpPerToolApprovals(settings, previousId);
    const previousLocalNames = server.knownTools.map((tool) => this.mcpKnownToolLocalName(server, tool));
    server.id = nextId;
    resetMcpServerSecretRefs(server);
    this.clearSecretIds(previousSecretIds.filter((id) => !this.mcpSecretIds(server).includes(id)));
    this.rebaseMcpKnownToolLocalNames(server);
    for (let index = 0; index < server.knownTools.length; index += 1) {
      const policy = previousApprovals[previousLocalNames[index]];
      const nextLocalName = this.mcpKnownToolLocalName(server, server.knownTools[index]);
      if (policy) settings.approval.perTool[nextLocalName] = policy;
    }
  }

  private clearMcpKnownToolsAndApprovals(settings: AgenticChatSettings, server: McpServerSettings): void {
    this.deleteMcpPerToolApprovals(settings, server.id);
    server.knownTools = [];
  }

  private clearMcpSecretSlots(server: McpServerSettings): void {
    this.clearSecretIds(this.mcpSecretIds(server));
  }

  private mcpSecretIds(server: McpServerSettings): string[] {
    return [
      server.authHeaderValueSecretId,
      server.oauth.clientSecretSecretId,
      server.oauth.accessTokenSecretId,
      server.oauth.refreshTokenSecretId,
    ].filter(Boolean);
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
    const prefix = localMcpToolName(serverId, "tool").slice(0, -"tool".length);
    const removed: Record<string, ApprovalPolicy> = {};
    for (const key of Object.keys(settings.approval.perTool)) {
      if (!key.startsWith(prefix)) continue;
      removed[key] = settings.approval.perTool[key];
      delete settings.approval.perTool[key];
    }
    return removed;
  }

  private rebaseMcpKnownToolLocalNames(server: McpServerSettings): void {
    const localNames = localMcpToolNames(server.id, server.knownTools.map((tool) => tool.name));
    for (let index = 0; index < server.knownTools.length; index += 1) {
      server.knownTools[index].localName = localNames[index];
    }
  }

  private mcpKnownToolLocalName(server: McpServerSettings, tool: McpKnownToolSettings): string {
    return tool.localName || localMcpToolName(server.id, tool.name);
  }

  private mcpCredentialResourceChanged(previousUrl: string, nextUrl: string): boolean {
    const previous = this.mcpCredentialResourceState(previousUrl);
    const next = this.mcpCredentialResourceState(nextUrl);
    if (previous.kind === "placeholder" && next.kind === "resource") return false;
    if (previous.kind === "resource" && next.kind === "resource") return previous.value !== next.value;
    return previous.kind !== next.kind;
  }

  private mcpCredentialResourceState(value: string): { kind: "placeholder" | "invalid" | "resource"; value?: string } {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "https://") return { kind: "placeholder" };
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "https:") return { kind: "invalid" };
      parsed.hash = "";
      parsed.search = "";
      if (parsed.pathname === "/") parsed.pathname = "";
      return { kind: "resource", value: parsed.toString().replace(/\/$/, "") };
    } catch {
      return { kind: "invalid" };
    }
  }

  private mcpAuthProblem(server: McpServerSettings): string {
    if (server.authType === "bearer") {
      if (!server.authHeaderValue.trim()) return "Enter a bearer token before testing this MCP server.";
      if (/[\r\n\0]/.test(server.authHeaderValue)) return "Bearer tokens must not contain line breaks or null bytes.";
      return "";
    }
    if (server.authType === "header") {
      if (!server.authHeaderName.trim()) return "Enter an auth header name before testing this MCP server.";
      if (!isValidHttpHeaderName(server.authHeaderName)) {
        return "Auth header names may contain only RFC token characters.";
      }
      if (!server.authHeaderValue.trim()) return "Enter an auth header value before testing this MCP server.";
      if (/[\r\n\0]/.test(server.authHeaderValue)) {
        return "Auth header values must not contain line breaks or null bytes.";
      }
    }
    return "";
  }

  private renderSecretInput(
    containerEl: HTMLElement,
    options: {
      name: string;
      desc: string;
      placeholder: string;
      hasValue: boolean;
      onSet: (value: string) => Promise<void>;
      onForget: () => Promise<void>;
    },
  ): void {
    const status = options.hasValue
      ? "A value is stored with Obsidian secret storage. Enter a new value to replace it."
      : "No value is stored yet.";
    new Setting(containerEl)
      .setName(options.name)
      .setDesc(`${options.desc} ${status}`)
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder(options.placeholder).setValue("").onChange(async (value) => {
          const trimmed = value.trim();
          if (!trimmed) return;
          await options.onSet(trimmed);
        });
      })
      .addButton((button) =>
        button
          .setButtonText("Forget")
          .setDisabled(!options.hasValue)
          .onClick(async () => {
            button.setDisabled(true);
            await options.onForget();
            this.display();
          }),
      );
  }

  /** Explain how secrets are persisted for provider and tool credentials. */
  private renderApiKeyWarning(containerEl: HTMLElement): void {
    const warning = containerEl.createDiv({ cls: "agentic-chat-settings-warning" });
    warning.createSpan({ cls: "agentic-chat-settings-warning-icon", text: "i" });
    warning.createSpan({
      text:
        "API keys and OAuth tokens are stored with Obsidian secret storage. The vault data.json stores " +
        "only secret IDs, not the secret values.",
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
