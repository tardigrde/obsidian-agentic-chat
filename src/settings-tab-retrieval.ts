import type { SettingDefinitionItem } from "obsidian";
import { activeEmbeddingModel } from "./retrieval/embeddings";
import { controlDef, row } from "./settings-definition-kit";
import { embeddingModelPlaceholder, type AgenticChatSettings } from "./settings-schema";
import { clampRowNumber, type SettingsTabHost } from "./settings-tab-host";

export function retrievalDefinitions(settings: AgenticChatSettings, host: SettingsTabHost): SettingDefinitionItem[] {
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
              setEmbeddingModel(settings, value);
              await host.save();
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
            const dimensions = clampRowNumber(value, 16, 16_384);
            if (dimensions !== undefined) settings.embeddings.dimensions = dimensions;
            await host.save();
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
            const batchSize = clampRowNumber(value, 1, 256);
            if (batchSize !== undefined) settings.embeddings.batchSize = batchSize;
            await host.save();
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
            const maxChars = clampRowNumber(value, 500, 200_000);
            if (maxChars !== undefined) settings.embeddings.maxDocumentChars = maxChars;
            await host.save();
          });
        });
    }),
  ];
}

export function ignoredFileDefinitions(settings: AgenticChatSettings, host: SettingsTabHost): SettingDefinitionItem[] {
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
            await host.save();
          });
        });
    }),
  ];
}

export function setEmbeddingModel(settings: AgenticChatSettings, value: string): void {
  const model = value.trim();
  if (settings.embeddings.provider === "ollama") settings.embeddings.ollamaModel = model;
  else if (settings.embeddings.provider === "openai-compatible") settings.embeddings.openaiCompatibleModel = model;
  else settings.embeddings.openrouterModel = model;
}
