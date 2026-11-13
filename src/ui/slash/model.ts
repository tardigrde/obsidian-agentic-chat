import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { apiKeyForProvider } from "../../settings-schema";
import { OUTPUT_STYLE_ORDER, OUTPUT_STYLES, type OutputStyle } from "../../agent/output-styles";
import { listOpenAICompatibleModels, listOpenRouterModels } from "../../llm/models";
import { createFetchFromWebFetcher, createProxiedFetcher } from "../../mcp/fetcher";
import { errorMessage } from "../../utils/errors";
import { modelProviderLabel } from "../chrome-state";
import { ModelSuggestModal } from "../model-suggest-modal";
import type { SlashContext } from "./context";

export async function switchModel(ctx: SlashContext): Promise<void> {
  const { settings } = ctx.plugin;
  if (settings.provider === "ollama") {
    ctx.renderErrorMessage("Set the Ollama model in plugin settings.");
    return;
  }
  const apiKey = apiKeyForProvider(settings, settings.provider);
  if (!apiKey) {
    ctx.renderErrorMessage(`Set your ${modelProviderLabel(settings.provider)} API key in settings first.`);
    return;
  }
  try {
    const fetchImpl = settings.network.proxyUrl
      ? createFetchFromWebFetcher(createProxiedFetcher(settings.network))
      : undefined;
    const models =
      settings.provider === "openrouter"
        ? (
            await listOpenRouterModels(apiKey, {
              zdr: settings.privacy.requireZDR,
              denyDataCollection: settings.privacy.denyDataCollection,
              fetchImpl,
              timeoutMs: settings.requestTimeoutMs,
            })
          )
            .filter((model) => model.supportsTools)
            .sort((a, b) => a.id.localeCompare(b.id))
        : (
            await listOpenAICompatibleModels(apiKey, {
              baseUrl: settings.openaiCompatibleBaseUrl,
              fetchImpl,
              timeoutMs: settings.requestTimeoutMs,
            })
          ).sort((a, b) => a.id.localeCompare(b.id));
    new ModelSuggestModal(ctx.app, models, (model, once) => {
      if (once) {
        // Per-request override: use this model for the next prompt only, then revert.
        ctx.service.setModelOverride(model.id);
      } else {
        if (settings.provider === "openrouter") settings.openrouterModel = model.id;
        else settings.openaiCompatibleModel = model.id;
        ctx.service.setModelOverride(null);
        void ctx.plugin.saveSettings();
      }
      ctx.syncChrome();
    }, `${modelProviderLabel(settings.provider)} model`).open();
  } catch (error) {
    ctx.renderErrorMessage(errorMessage(error));
  }
}

/** `/style [name]`: no arg shows a picker; an arg switches output style directly. */
export async function runStyle(ctx: SlashContext, arg: string): Promise<void> {
  ctx.clearEmptyState();
  if (!arg) {
    showStyleList(ctx);
    return;
  }
  const lower = arg.toLowerCase();
  const style = OUTPUT_STYLE_ORDER.find((id) => id === lower || OUTPUT_STYLES[id].label.toLowerCase() === lower);
  if (!style) {
    ctx.renderErrorMessage(`Unknown output style "${arg}". Options: ${OUTPUT_STYLE_ORDER.join(", ")}.`);
    return;
  }
  await chooseStyle(ctx, style);
}

/** Clickable output-style picker, applied in-pane. */
export function showStyleList(ctx: SlashContext): void {
  const { settings } = ctx.plugin;
  ctx.renderActionList(
    "Output style",
    `How the assistant talks · current: ${OUTPUT_STYLES[settings.outputStyle].label}`,
    OUTPUT_STYLE_ORDER.map((id) => ({
      label: OUTPUT_STYLES[id].label,
      detail: OUTPUT_STYLES[id].description,
      icon: OUTPUT_STYLES[id].icon,
      onClick: () => void chooseStyle(ctx, id),
    })),
  );
}

export async function chooseStyle(ctx: SlashContext, style: OutputStyle): Promise<void> {
  await ctx.setOutputStyle(style);
  ctx.renderInfoMessage("Output style", [[OUTPUT_STYLES[style].label, OUTPUT_STYLES[style].description]]);
}

/** `/effort [level]`: no arg shows a picker; an arg sets your reasoning effort (persisted). */
export function runEffort(ctx: SlashContext, arg: string): void {
  ctx.clearEmptyState();
  if (!arg) {
    showEffortList(ctx);
    return;
  }
  const lower = arg.toLowerCase();
  const levels = ctx.service.getActiveThinkingLevels();
  const level = levels.find((id) => id === lower);
  if (!level) {
    ctx.renderErrorMessage(`Unknown or unsupported effort "${arg}". Options: ${levels.join(", ")}.`);
    return;
  }
  void chooseEffort(ctx, level);
}

/** Clickable effort picker. The subtitle warns that switching costs a one-time cache miss. */
export function showEffortList(ctx: SlashContext): void {
  const current = ctx.service.getActiveThinkingLevel();
  const levels = ctx.service.getActiveThinkingLevels();
  if (levels.length <= 1) {
    ctx.renderInfoMessage("Effort", [
      ["off", "The active model only exposes reasoning effort as off."],
    ]);
    return;
  }
  ctx.renderActionList(
    "Effort",
    `Reasoning effort for your messages · current: ${current}. ` +
      "Changing it re-processes the prompt once (a cache miss) — affects cost.",
    levels.map((id) => ({
      label: id,
      detail: id === current ? "current" : "",
      icon: "gauge",
      onClick: () => void chooseEffort(ctx, id),
    })),
  );
}

/** Apply an effort level and remember it (persisted). */
export async function chooseEffort(ctx: SlashContext, level: ThinkingLevel): Promise<void> {
  if (ctx.service.isStreaming()) {
    ctx.renderErrorMessage("Can't change effort while the agent is responding.");
    return;
  }
  try {
    await persistEffortLevel(ctx, level);
  } catch (error) {
    ctx.renderErrorMessage(
      `Could not save effort level: ${errorMessage(error)}`,
    );
    return;
  }
  ctx.renderInfoMessage("Effort", [
    [level, "Saved. Applies to your messages going forward; switching effort re-processes the prompt once (a cache miss) — affects cost."],
  ]);
}

/**
 * Persist the chosen effort level and repaint the knob. Rolls the setting
 * back if saving fails, so the UI never advertises a level that didn't stick.
 */
export async function persistEffortLevel(ctx: SlashContext, level: ThinkingLevel): Promise<void> {
  const previous = ctx.plugin.settings.thinkingLevel;
  if (previous === level) return;
  ctx.plugin.settings.thinkingLevel = level;
  // Repaint instantly; persistence lands in the background.
  ctx.syncChrome();
  try {
    await ctx.plugin.saveSettings();
  } catch (error) {
    ctx.plugin.settings.thinkingLevel = previous;
    ctx.syncChrome();
    throw error;
  }
}
