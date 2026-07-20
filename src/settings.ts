import { App, Notice, Platform, PluginSettingTab, Setting, type ButtonComponent, type SettingDefinitionItem } from "obsidian";
import { normalizeFolderPath } from "./vault/path";
import type AgenticChatPlugin from "./main";
import {
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  DEFAULT_OLLAMA_BASE_URL,
  listOpenRouterModels,
  type ProviderId,
} from "./llm/models";
import { type ApprovalPolicy } from "./agent/approval";
import { type AgentMode, MODES, TOGGLE_MODES } from "./agent/modes";
import { DEFAULT_SYSTEM_PROMPT } from "./agent/system-prompt";
import { MUTATING_TOOLS } from "./tools/tool-contracts";
import { createVaultTools } from "./tools/vault-tools";
import {
  createMcpServerSettings,
  exportMcpServerConfig,
  importMcpServerConfig,
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
import { localMcpToolName, localMcpToolNames, probeMcpServer } from "./mcp/tools";
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
import {
  WEB_SEARCH_PROVIDER_LABELS,
  WEB_SEARCH_PROVIDERS,
  type WebSearchProvider,
} from "./tools/web-search";
import { FolderSuggestModal } from "./ui/folder-suggest";
import { ModelSuggestModal } from "./ui/model-suggest-modal";
import {
  type ObservabilityBackend,
  type ObservabilityPayloadMode,
} from "./observability/settings";
import {
  activeEmbeddingModel,
  DEFAULT_EMBEDDING_SETTINGS,
  type EmbeddingProviderId,
  type EmbeddingSettings,
} from "./retrieval/embeddings";

import {
  DEFAULT_EXTERNAL_IGNORED_GLOBS,
  DEFAULT_SETTINGS,
  PROVIDERS,
  PROVIDER_LABELS,
  embeddingModelPlaceholder,
  type AgenticChatSettings,
  type NetworkSettings,
} from "./settings-schema";
export {
  DEFAULT_EXTERNAL_IGNORED_GLOBS,
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
  ExternalWorkspaceSettings,
  NetworkSettings,
  NotificationSettings,
  WebSettings,
} from "./settings-schema";
const OBSERVABILITY_BACKEND_LABELS: Record<ObservabilityBackend, string> = {
  langfuse: "Langfuse",
  otlp: "Generic OTLP",
};

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
    void this.save().then(() => this.display());
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [];
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
    { label: "Observability", render: (el, settings) => this.renderObservability(el, settings) },
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
          .setPlaceholder("https://192.0.2.10:3128")
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
              this.refresh();
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
      .setDesc("Base URL for an OpenAI chat-completions compatible gateway. Bare OpenWebUI roots are resolved to /api.")
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

    new Setting(containerEl).setName("Tool budget").setHeading();
    new Setting(containerEl)
      .setName("Drop optional tools when schemas are large")
      .setDesc(
        "When registered tool schemas alone exceed the threshold, hide optional expansion tools such as web, MCP, artifacts, PDF import, and subagents.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.toolBudget.enabled).onChange(async (value) => {
          settings.toolBudget.enabled = value;
          await this.save();
        }),
      );
    new Setting(containerEl)
      .setName("Drop tools when schemas exceed (% of context window)")
      .setDesc("Low by default so large tool catalogs shed optional tools before tool schemas become expensive.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 50, 1)
          .setValue(settings.toolBudget.thresholdPercent)
          .onChange(async (value) => {
            settings.toolBudget.thresholdPercent = value;
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
              this.refresh();
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
          .setPlaceholder("https://host:port")
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
        button.setButtonText("Import config").onClick(async () => {
          await this.importMcpConfigFromClipboard(settings);
        }),
      )
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

  private renderObservability(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    new Setting(containerEl).setName("Observability export").setHeading();

    const warning = containerEl.createDiv({ cls: "agentic-chat-settings-warning" });
    warning.createSpan({ cls: "agentic-chat-settings-warning-icon", text: "i" });
    warning.createSpan({
      text:
        "Observability is opt-in and has no built-in endpoint. When enabled, Agentic Chat exports " +
        "turn, model, tool, approval, token, and cost metadata to the endpoint you configure. Prompt " +
        "and answer text is withheld unless you explicitly change payload detail below.",
    });

    new Setting(containerEl)
      .setName("Enable observability")
      .setDesc("Export OTLP/HTTP traces for agent turns. Leave off for the default no-telemetry behavior.")
      .addToggle((toggle) =>
        toggle.setValue(settings.observability.enabled).onChange(async (value) => {
          settings.observability.enabled = value;
          await this.save();
          this.display();
        }),
      );

    if (!settings.observability.enabled) return;

    new Setting(containerEl)
      .setName("Backend")
      .setDesc("Langfuse configures OTLP headers for Langfuse ingestion; generic OTLP accepts a direct /v1/traces endpoint.")
      .addDropdown((dropdown) => {
        for (const backend of Object.keys(OBSERVABILITY_BACKEND_LABELS) as ObservabilityBackend[]) {
          dropdown.addOption(backend, OBSERVABILITY_BACKEND_LABELS[backend]);
        }
        dropdown.setValue(settings.observability.backend).onChange(async (value) => {
          settings.observability.backend = value as ObservabilityBackend;
          await this.save();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName(settings.observability.backend === "langfuse" ? "Langfuse base URL" : "OTLP traces endpoint")
      .setDesc(
        settings.observability.backend === "langfuse"
          ? "Corporate/self-hosted Langfuse base URL. The plugin posts to /api/public/otel/v1/traces."
          : "Full OTLP HTTP/JSON traces endpoint, usually ending in /v1/traces.",
      )
      .addText((text) =>
        text
          .setPlaceholder(settings.observability.backend === "langfuse" ? "https://langfuse.example.com" : "https://otel.example.com/v1/traces")
          .setValue(settings.observability.endpoint)
          .onChange(async (value) => {
            settings.observability.endpoint = value.trim();
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Payload detail")
      .setDesc(
        "Metadata only sends timings, model ids, token/cost totals, tool names, approvals, and errors. " +
        "Text modes send prompt/answer text to the configured backend.",
      )
      .addDropdown((dropdown) => {
        for (const mode of Object.keys(OBSERVABILITY_PAYLOAD_LABELS) as ObservabilityPayloadMode[]) {
          dropdown.addOption(mode, OBSERVABILITY_PAYLOAD_LABELS[mode]);
        }
        dropdown.setValue(settings.observability.payloadMode).onChange(async (value) => {
          settings.observability.payloadMode = value as ObservabilityPayloadMode;
          await this.save();
        });
      });

    new Setting(containerEl)
      .setName("Sample rate")
      .setDesc("Percentage of agent turns to export.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 100, 1)
          .setValue(settings.observability.sampleRate)
          .onChange(async (value) => {
            settings.observability.sampleRate = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("HTTP proxy")
      .setDesc("Optional observability-only override. Leave empty to inherit the global network proxy from the Models tab.")
      .addText((text) =>
        text
          .setPlaceholder("https://host:port")
          .setValue(settings.observability.proxyUrl)
          .onChange(async (value) => {
            settings.observability.proxyUrl = value.trim();
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("No proxy")
      .setDesc("Comma-separated hosts/domains that bypass the observability proxy.")
      .addText((text) =>
        text
          .setPlaceholder("localhost,127.0.0.1,::1")
          .setValue(settings.observability.noProxy)
          .onChange(async (value) => {
            settings.observability.noProxy = value.trim();
            await this.save();
          }),
      );

    if (settings.observability.backend === "langfuse") {
      this.renderSecretInput(containerEl, {
        name: "Langfuse public key",
        desc: "Public key for the configured Langfuse project.",
        placeholder: "pk-lf-...",
        hasValue: Boolean(settings.observability.langfusePublicKey),
        onSet: async (value) => {
          settings.observability.langfusePublicKey = value;
          await this.save();
        },
        onForget: async () => {
          settings.observability.langfusePublicKey = "";
          await this.save();
        },
      });
      this.renderSecretInput(containerEl, {
        name: "Langfuse secret key",
        desc: "Secret key for the configured Langfuse project.",
        placeholder: "sk-lf-...",
        hasValue: Boolean(settings.observability.langfuseSecretKey),
        onSet: async (value) => {
          settings.observability.langfuseSecretKey = value;
          await this.save();
        },
        onForget: async () => {
          settings.observability.langfuseSecretKey = "";
          await this.save();
        },
      });
      return;
    }

    new Setting(containerEl)
      .setName("Auth header name")
      .setDesc("Optional header name for a generic OTLP backend, e.g. Authorization.")
      .addText((text) =>
        text
          .setPlaceholder("Authorization")
          .setValue(settings.observability.authHeaderName)
          .onChange(async (value) => {
            settings.observability.authHeaderName = value.trim();
            await this.save();
          }),
      );

    this.renderSecretInput(containerEl, {
      name: "Auth header value",
      desc: "Optional header value for the generic OTLP backend.",
      placeholder: "Bearer ...",
      hasValue: Boolean(settings.observability.authHeaderValue),
      onSet: async (value) => {
        settings.observability.authHeaderValue = value;
        await this.save();
      },
      onForget: async () => {
        settings.observability.authHeaderValue = "";
        await this.save();
      },
    });
  }

  private renderMcpServer(
    containerEl: HTMLElement,
    settings: AgenticChatSettings,
    server: McpServerSettings,
  ): void {
    const endpointProblem = mcpEndpointProblem(server.url);
    let testButton: ButtonComponent | undefined;
    const syncTestButton = (): void => {
      if (!testButton) return;
      const state = mcpTestButtonState(server);
      testButton.setButtonText(state.label).setDisabled(Boolean(state.problem));
    };
    const header = new Setting(containerEl)
      .setName(server.name || server.id)
      .setDesc(formatMcpServerSummary(server, endpointProblem))
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

    this.renderMcpSetupGuide(containerEl, server);
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
      const localName = mcpKnownToolLocalName(server, tool);
      const title = tool.title && tool.title !== tool.name ? `${tool.title} (${tool.name})` : tool.name;
      new Setting(containerEl)
        .setName(title)
        .setDesc(formatMcpToolApprovalDescription(localName, tool))
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

  private renderMcpAuthentication(
    containerEl: HTMLElement,
    server: McpServerSettings,
    onAuthChanged: () => void,
  ): void {
    const authProblem = mcpAuthProblem(server);
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
    const scopePart = server.oauth.scope ? ` with scopes: ${server.oauth.scope}` : "";
    new Setting(containerEl)
      .setName("OAuth status")
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
            await this.save();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("OAuth desktop redirect URI")
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

    new Setting(containerEl)
      .setName("OAuth mobile redirect URI")
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

  private async refreshMcpKnownTools(server: McpServerSettings, button?: ButtonComponent): Promise<void> {
    button?.setDisabled(true);
    try {
      const result = await this.probeAndCacheMcpTools(server);
      const sample = formatMcpToolSample(result.toolNames);
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
    const endpointProblem = mcpEndpointProblem(server.url);
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
    const sample = formatMcpToolSample(result.toolNames);
    new Notice(
      `${server.name}: connected; discovered ${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}${sample}.`,
    );
    this.display();
  }

  private async authenticateAndProbeMcpServer(server: McpServerSettings): Promise<void> {
    const fetcher = createMcpFetcher(this.effectiveMcpProxySettings());
    await authenticateMcpServer(server, fetcher, {
      callbackReceiver: Platform.isMobileApp ? this.plugin.createMcpOAuthCallbackReceiver() : undefined,
      onProgress: (event) => this.handleMcpOAuthProgress(server, event),
    });
    const result = await probeMcpServer(server, fetcher, {
      onServerChanged: () => this.save(),
    });
    server.knownTools = result.tools;
    await this.save();
    const sample = formatMcpToolSample(result.toolNames);
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

  private async readFromClipboard(): Promise<string> {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard?.readText) return "";
    try {
      return await clipboard.readText();
    } catch {
      return "";
    }
  }

  private async importMcpConfigFromClipboard(settings: AgenticChatSettings): Promise<void> {
    const raw = await this.readFromClipboard();
    if (!raw.trim()) {
      new Notice("Agentic Chat MCP: clipboard does not contain an MCP config.");
      return;
    }
    try {
      const server = importMcpServerConfig(JSON.parse(raw));
      this.upsertMcpServer(settings, server);
      await this.save();
      new Notice(`${server.name}: imported MCP config.`);
      this.display();
    } catch (error) {
      new Notice(`Agentic Chat MCP: ${error instanceof Error ? error.message : String(error)}`);
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
    server.id = nextId;
    resetMcpServerSecretRefs(server);
    this.clearSecretIds(previousSecretIds.filter((id) => !mcpSecretIds(server).includes(id)));
    this.rebaseMcpKnownToolLocalNames(server);
    for (let index = 0; index < server.knownTools.length; index += 1) {
      const policy = previousApprovals[previousLocalNames[index]];
      const nextLocalName = mcpKnownToolLocalName(server, server.knownTools[index]);
      if (policy) settings.approval.perTool[nextLocalName] = policy;
    }
  }

  private clearMcpKnownToolsAndApprovals(settings: AgenticChatSettings, server: McpServerSettings): void {
    this.deleteMcpPerToolApprovals(settings, server.id);
    server.knownTools = [];
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

  private renderMcpSetupGuide(containerEl: HTMLElement, server: McpServerSettings): void {
    const description = mcpServerSetupSteps(server)
      .map((step) => `${step.label}: ${step.status === "complete" ? "done" : step.status} - ${step.message}`)
      .join(" ");
    new Setting(containerEl)
      .setName("Setup guide")
      .setDesc(description)
      .addButton((button) =>
        button.setButtonText("Copy config").onClick(async () => {
          const copied = await this.copyToClipboard(JSON.stringify(exportMcpServerConfig(server), null, 2));
          new Notice(copied ? `${server.name}: MCP config copied without secrets.` : `${server.name}: could not copy MCP config.`);
        }),
      );
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

    this.renderExternalWorkspace(containerEl, settings);

    new Setting(containerEl).setName("Semantic retrieval").setHeading();
    new Setting(containerEl)
      .setName("Embeddings")
      .setDesc(
        "Opt-in semantic index configuration. Indexing is still scoped and explicit; provider API keys reuse the Models tab.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.embeddings.enabled).onChange(async (value) => {
          settings.embeddings.enabled = value;
          await this.save();
        }),
      );
    new Setting(containerEl)
      .setName("Embedding provider")
      .setDesc("OpenRouter for hosted embeddings, Ollama for local embeddings, or the configured OpenAI-compatible gateway.")
      .addDropdown((dropdown) => {
        const options: Record<EmbeddingProviderId, string> = {
          openrouter: "OpenRouter",
          ollama: "Ollama (local)",
          "openai-compatible": "OpenAI-compatible",
        };
        for (const [value, label] of Object.entries(options)) dropdown.addOption(value, label);
        dropdown.setValue(settings.embeddings.provider).onChange(async (value) => {
          settings.embeddings.provider = value as EmbeddingProviderId;
          await this.save();
          this.display();
        });
      });
    new Setting(containerEl)
      .setName("Embedding model")
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
    new Setting(containerEl)
      .setName("Vector dimensions")
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
    new Setting(containerEl)
      .setName("Language coverage")
      .setDesc("Controls retrieval diagnostics for cross-language search.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("multilingual", "Multilingual")
          .addOption("monolingual", "Monolingual")
          .addOption("unknown", "Unknown")
          .setValue(settings.embeddings.languageCoverage)
          .onChange(async (value) => {
            settings.embeddings.languageCoverage = value as EmbeddingSettings["languageCoverage"];
            await this.save();
          }),
      );
    new Setting(containerEl)
      .setName("Batch size")
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
    new Setting(containerEl)
      .setName("Max indexed characters per note")
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

  private renderExternalWorkspace(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    new Setting(containerEl).setName("External workspace root").setHeading();

    const desktopOnly = !Platform.isDesktopApp;
    if (desktopOnly) {
      const warning = containerEl.createDiv({ cls: "agentic-chat-settings-warning" });
      warning.createSpan({ cls: "agentic-chat-settings-warning-icon", text: "⚠" });
      warning.createSpan({
        text: "External workspace root tools are desktop-only. They are never registered on Obsidian mobile.",
      });
    }

    new Setting(containerEl)
      .setName("Enable external root tools")
      .setDesc(
        "Desktop-only. Registers the read-only external_inspect tool only when this is enabled and a root path is configured.",
      )
      .addToggle((toggle) =>
        toggle
          .setDisabled(desktopOnly)
          .setValue(settings.external.enabled)
          .onChange(async (value) => {
            settings.external.enabled = value;
            await this.save();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("External root path")
      .setDesc("Absolute path to the one external directory the agent may inspect. This is not added to prompt context.")
      .addText((text) =>
        text
          .setDisabled(desktopOnly)
          .setPlaceholder("/path/to/codebase")
          .setValue(settings.external.rootPath)
          .onChange(async (value) => {
            settings.external.rootPath = value.trim();
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Approval for external inspection")
      .setDesc("Read-only external_inspect calls ask by default. Allow or deny only when you deliberately trust the standing policy.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("ask", "Ask each time")
          .addOption("allow", "Allow automatically")
          .addOption("deny", "Deny automatically")
          .setDisabled(desktopOnly)
          .setValue(settings.external.approval)
          .onChange(async (value) => {
            settings.external.approval = value === "allow" || value === "deny" ? value : "ask";
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Honor .gitignore")
      .setDesc("Apply root and nested .gitignore files while listing, reading, and searching external files.")
      .addToggle((toggle) =>
        toggle
          .setDisabled(desktopOnly)
          .setValue(settings.external.honorGitignore)
          .onChange(async (value) => {
            settings.external.honorGitignore = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("External ignore list")
      .setDesc("One gitignore-style rule per line, scoped to the external root. Separate from the vault ignore list.")
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.inputEl.addClass("agentic-chat-system-prompt");
        text
          .setDisabled(desktopOnly)
          .setPlaceholder(DEFAULT_EXTERNAL_IGNORED_GLOBS)
          .setValue(settings.external.ignoredGlobs)
          .onChange(async (value) => {
            settings.external.ignoredGlobs = value;
            await this.save();
          });
      });
  }

  private setEmbeddingModel(settings: AgenticChatSettings, value: string): void {
    const model = value.trim();
    if (settings.embeddings.provider === "ollama") settings.embeddings.ollamaModel = model;
    else if (settings.embeddings.provider === "openai-compatible") settings.embeddings.openaiCompatibleModel = model;
    else settings.embeddings.openrouterModel = model;
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
