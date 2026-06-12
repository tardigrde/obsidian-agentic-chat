import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting } from "obsidian";
import type AgenticChatPlugin from "./main";
import { OpenRouterModelInfo, PrivacySettings, listModels } from "./llm/openrouter";

export interface AgenticChatSettings {
  apiKey: string;
  model: string;
  temperature: number;
  /** 0 means "let the provider decide". */
  maxTokens: number;
  maxSteps: number;
  requestTimeoutMs: number;
  maxNetworkRetries: number;
  systemPrompt: string;
  privacy: PrivacySettings;
}

export const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant embedded in Obsidian, the note-taking app. You help the user work with their vault (their collection of Markdown notes).

You have tools to read, search, list, and write notes. Use them proactively:
- When the user refers to a note or to "my notes", find and read the relevant notes before answering.
- Prefer search_vault or list_folder to discover paths instead of guessing them.
- When asked to create or modify notes, use write_note, then briefly confirm what changed.
- Refer to notes by their vault path, like "Folder/Note.md".

Be concise. Format answers in Markdown.`;

export const DEFAULT_SETTINGS: AgenticChatSettings = {
  apiKey: "",
  model: "anthropic/claude-sonnet-4.5",
  temperature: 0.3,
  maxTokens: 0,
  maxSteps: 12,
  requestTimeoutMs: 90_000,
  maxNetworkRetries: 2,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  privacy: {
    denyDataCollection: true,
    requireZDR: false,
    allowFallbacks: true,
  },
};

class ModelSuggestModal extends FuzzySuggestModal<OpenRouterModelInfo> {
  constructor(
    app: App,
    private readonly models: OpenRouterModelInfo[],
    private readonly onChoose: (model: OpenRouterModelInfo) => void,
  ) {
    super(app);
    this.setPlaceholder("Pick an OpenRouter model (tool-calling capable)…");
  }

  getItems(): OpenRouterModelInfo[] {
    return this.models;
  }

  getItemText(model: OpenRouterModelInfo): string {
    const context = model.contextLength ? ` · ${Math.round(model.contextLength / 1000)}k ctx` : "";
    return `${model.id}${context}`;
  }

  onChooseItem(model: OpenRouterModelInfo): void {
    this.onChoose(model);
  }
}

export class AgenticChatSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: AgenticChatPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const { settings } = this.plugin;
    containerEl.empty();

    new Setting(containerEl)
      .setName("OpenRouter API key")
      .setDesc("Create one at openrouter.ai/keys. Stored locally in this plugin's data file.")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-or-…")
          .setValue(settings.apiKey)
          .onChange(async (value) => {
            settings.apiKey = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Model")
      .setDesc('OpenRouter model ID. "Browse" lists models that support tool calling.')
      .addText((text) =>
        text
          .setPlaceholder("anthropic/claude-sonnet-4.5")
          .setValue(settings.model)
          .onChange(async (value) => {
            settings.model = value.trim();
            await this.plugin.saveSettings();
          }),
      )
      .addButton((button) =>
        button.setButtonText("Browse").onClick(async () => {
          if (!settings.apiKey) {
            new Notice("Set your OpenRouter API key first.");
            return;
          }
          button.setDisabled(true);
          try {
            const models = (await listModels(settings.apiKey))
              .filter((model) => model.supportsTools)
              .sort((a, b) => a.id.localeCompare(b.id));
            new ModelSuggestModal(this.app, models, async (model) => {
              settings.model = model.id;
              await this.plugin.saveSettings();
              this.display();
            }).open();
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            new Notice(`Agentic chat: ${message}`);
          } finally {
            button.setDisabled(false);
          }
        }),
      );

    new Setting(containerEl).setName("Privacy").setHeading();

    new Setting(containerEl)
      .setName("Deny prompt logging and training")
      .setDesc(
        'Only route to providers that do not store your prompts or train on them (OpenRouter provider data policy "deny").',
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.privacy.denyDataCollection).onChange(async (value) => {
          settings.privacy.denyDataCollection = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Require zero data retention")
      .setDesc(
        "Only route to endpoints with a Zero Data Retention policy. Strictest option; some models become unavailable.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.privacy.requireZDR).onChange(async (value) => {
          settings.privacy.requireZDR = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Allow provider fallbacks")
      .setDesc(
        "Let OpenRouter fall back to other providers that still satisfy the privacy rules above when the preferred one is down.",
      )
      .addToggle((toggle) =>
        toggle.setValue(settings.privacy.allowFallbacks).onChange(async (value) => {
          settings.privacy.allowFallbacks = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Agent").setHeading();

    new Setting(containerEl)
      .setName("Max agent steps")
      .setDesc("Maximum model round-trips (tool-calling cycles) per message.")
      .addSlider((slider) =>
        slider
          .setLimits(2, 30, 1)
          .setValue(settings.maxSteps)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.maxSteps = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Temperature")
      .addSlider((slider) =>
        slider
          .setLimits(0, 2, 0.1)
          .setValue(settings.temperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            settings.temperature = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Max response tokens")
      .setDesc("Per model request. 0 lets the provider decide.")
      .addText((text) =>
        text.setValue(String(settings.maxTokens)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.maxTokens = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Request timeout (seconds)")
      .setDesc("How long to wait for OpenRouter to start responding.")
      .addText((text) =>
        text.setValue(String(Math.round(settings.requestTimeoutMs / 1000))).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          settings.requestTimeoutMs =
            Number.isFinite(parsed) && parsed >= 5 ? parsed * 1000 : DEFAULT_SETTINGS.requestTimeoutMs;
          await this.plugin.saveSettings();
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
            await this.plugin.saveSettings();
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
          await this.plugin.saveSettings();
        });
      });
  }
}
