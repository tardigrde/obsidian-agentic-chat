import { App, Notice, PluginSettingTab, Setting } from "obsidian";
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
import { DEFAULT_SYSTEM_PROMPT } from "./agent/system-prompt";
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
  privacy: PrivacySettings;
  approval: ApprovalSettings;
  /** Vault folder scanned for SKILL.md skills/personas. Empty disables skills. */
  skillsFolder: string;
  /** Vault folder scanned for reusable prompt templates. Empty disables templates. */
  templatesFolder: string;
}

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export const DEFAULT_SETTINGS: AgenticChatSettings = {
  provider: "openrouter",
  openrouterApiKey: "",
  openrouterModel: "anthropic/claude-sonnet-4.5",
  ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
  ollamaModel: "llama3.1",
  thinkingLevel: "off",
  temperature: 0.3,
  maxTokens: 0,
  requestTimeoutMs: 90_000,
  maxNetworkRetries: 2,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  privacy: { denyDataCollection: true, requireZDR: false, allowFallbacks: true },
  approval: DEFAULT_APPROVAL_SETTINGS,
  skillsFolder: "",
  templatesFolder: "",
};

/** Merge stored settings over defaults, healing nested objects. */
export function mergeSettings(stored: Partial<AgenticChatSettings> | null | undefined): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(stored?.privacy ?? {}) },
    approval: {
      ...DEFAULT_SETTINGS.approval,
      ...(stored?.approval ?? {}),
      perTool: { ...(stored?.approval?.perTool ?? {}) },
    },
  };
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

  display(): void {
    const { containerEl } = this;
    const { settings } = this.plugin;
    containerEl.empty();

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

    this.renderAgent(containerEl, settings);
    this.renderApproval(containerEl, settings);
    this.renderResources(containerEl, settings);
  }

  private renderOpenRouter(containerEl: HTMLElement, settings: AgenticChatSettings): void {
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
          .setPlaceholder("anthropic/claude-sonnet-4.5")
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
            const models = (await listOpenRouterModels(settings.openrouterApiKey))
              .filter((model) => model.supportsTools)
              .sort((a, b) => a.id.localeCompare(b.id));
            new ModelSuggestModal(this.app, models, async (model) => {
              settings.openrouterModel = model.id;
              await this.save();
              this.display();
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
      .setDesc("Only route to ZDR endpoints. Strictest option; some models become unavailable.")
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
        .setDynamicTooltip()
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
          .setDynamicTooltip()
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
  }

  private renderApproval(containerEl: HTMLElement, settings: AgenticChatSettings): void {
    new Setting(containerEl).setName("Approval gates").setHeading();
    new Setting(containerEl)
      .setName("Before mutating tools")
      .setDesc("Gate write, edit, rename, and delete. Read-only tools always run. 'Ask' shows a confirm dialog.")
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
      "Prompt templates folder",
      "Vault folder of reusable prompt templates (support $ARGUMENTS). Leave empty to disable.",
      settings.templatesFolder,
      async (value) => {
        settings.templatesFolder = value;
        await this.save();
      },
    );
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
