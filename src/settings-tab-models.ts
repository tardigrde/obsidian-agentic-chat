import { Notice, type SettingDefinitionItem } from "obsidian";
import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL, DEFAULT_OLLAMA_BASE_URL, listOpenRouterModels } from "./llm/models";
import { createFetchFromWebFetcher, createProxiedFetcher } from "./mcp/fetcher";
import { DEFAULT_PROXY_SETTINGS, PROXY_URL_EXAMPLE } from "./network/proxy";
import { apiKeyWarning, controlDef, headingRow, row } from "./settings-definition-kit";
import {
  PROVIDERS,
  PROVIDER_LABELS,
  type AgenticChatSettings,
} from "./settings-schema";
import { ModelSuggestModal } from "./ui/model-suggest-modal";
import { errorMessage } from "./utils/errors";
import type { SettingsTabHost } from "./settings-tab-host";

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

export function modelsDefinitions(settings: AgenticChatSettings, host: SettingsTabHost): SettingDefinitionItem[] {
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
    items.push(...openRouterDefinitions(settings, host));
  } else if (settings.provider === "openai-compatible") {
    items.push(...openAICompatibleDefinitions(settings, host));
  } else {
    items.push(...ollamaDefinitions());
  }
  return items;
}

export function openRouterDefinitions(settings: AgenticChatSettings, host: SettingsTabHost): SettingDefinitionItem[] {
  return [
    apiKeyWarning(),
    host.secretInputDef({
      name: "OpenRouter API key",
      desc: "Create one at openrouter.ai/keys.",
      placeholder: "sk-or-...",
      hasValue: () => Boolean(settings.openrouterApiKey),
      onSet: async (value) => {
        settings.openrouterApiKey = value;
        await host.save();
      },
      onForget: async () => {
        settings.openrouterApiKey = "";
        await host.save();
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
              await host.save();
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
              new ModelSuggestModal(host.app, models, (model) => {
                settings.openrouterModel = model.id;
                host.refresh();
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

export function ollamaDefinitions(): SettingDefinitionItem[] {
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

export function openAICompatibleDefinitions(
  settings: AgenticChatSettings,
  host: SettingsTabHost,
): SettingDefinitionItem[] {
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
            await host.save();
            host.redraw();
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
    host.secretInputDef({
      name: "API key",
      desc: "Bearer token for the configured OpenAI-compatible gateway.",
      placeholder: activePreset?.apiKeyPlaceholder ?? "sk-...",
      hasValue: () => Boolean(settings.openaiCompatibleApiKey),
      onSet: async (value) => {
        settings.openaiCompatibleApiKey = value;
        await host.save();
      },
      onForget: async () => {
        settings.openaiCompatibleApiKey = "";
        await host.save();
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
              await host.save();
            }),
        );
    }),
  ];
}
