import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";

/**
 * U4 #6: the vault's catalog file was written by a release before the image
 * flag (no `version`, no `im` on any model). The plugin loaded it, started one
 * background fetch that failed, and called a vision model text-only. Load the
 * file from disk the way a plugin start does, then build the model.
 */

const requestUrl = vi.fn();
vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requestUrl: (...args: unknown[]) => requestUrl(...args),
}));

import * as pricingCache from "../src/llm/pricing-cache";
import {
  CATALOG_RETRY_DELAYS_MS,
  clearPricingCacheForTests,
  loadPricingCacheFromFileForTests,
  modelCatalogStatus,
  waitForCatalogFetchForTests,
} from "../src/llm/pricing-cache";
import { buildModel, type ModelConfig } from "../src/llm/models";
import { FakeAdapter } from "./support/fake-adapter";

const FILE = ".obsidian/plugins/agentic-chat/pricing-cache.json";
const V1 = readFileSync("test/fixtures/pricing-cache/v1-no-image-flag.json", "utf8");

function config(modelId: string, provider: ModelConfig["provider"] = "openrouter"): ModelConfig {
  return {
    provider,
    modelId,
    privacy: { denyDataCollection: true, requireZDR: true, allowFallbacks: true },
    ollamaBaseUrl: "http://localhost:11434",
    openaiCompatibleBaseUrl: "http://localhost:3000/api",
  };
}

const catalogPayload = {
  data: [
    {
      id: "deepseek/deepseek-v4.1-flash-1017",
      name: "DeepSeek V4.1 Flash",
      context_length: 163840,
      architecture: { input_modalities: ["text", "image"] },
      pricing: { prompt: "0.0000001", completion: "0.0000004" },
      supported_parameters: ["tools"],
    },
    {
      id: "deepseek/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      context_length: 163840,
      architecture: { input_modalities: ["text"] },
      pricing: { prompt: "0.000001", completion: "0.000002" },
      supported_parameters: ["tools"],
    },
  ],
};

afterEach(() => {
  clearPricingCacheForTests();
  requestUrl.mockReset();
  vi.useRealTimers();
});

describe("model catalog from an older release (U4 #6)", () => {
  it("a v1 file with no image flag never makes a vision model text-only, even when the refresh fails", async () => {
    requestUrl.mockResolvedValue({ status: 503, json: {} });
    const adapter = new FakeAdapter({ [FILE]: V1 });
    // A plugin start: the same entry point main.ts calls.
    pricingCache.initPricingCache(
      { vault: { adapter, configDir: ".obsidian" } } as never,
      { manifest: { dir: ".obsidian/plugins/agentic-chat", id: "agentic-chat" } } as never,
    );
    for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));

    expect(buildModel(config("deepseek/deepseek-v4.1-flash-1017")).input).toEqual(["text", "image"]);
    // Pricing from the old file still applies.
    expect(buildModel(config("deepseek/deepseek-v4.1-flash-1017")).cost.input).toBe(0.1);
  });

  it("a failed refresh is visible to /doctor, not only in the console", async () => {
    requestUrl.mockResolvedValue({ status: 503, json: {} });
    const adapter = new FakeAdapter({ [FILE]: V1 });
    await loadPricingCacheFromFileForTests(adapter as unknown as DataAdapter, FILE);
    await waitForCatalogFetchForTests();
    expect(modelCatalogStatus()).toMatchObject({ outdated: true, models: 2, lastError: expect.stringContaining("503"), failedAttempts: 1 });
  });

  it("retries a failed fetch with backoff and rewrites the file once it succeeds", async () => {
    vi.useFakeTimers();
    requestUrl.mockResolvedValueOnce({ status: 503, json: {} }).mockResolvedValue({ status: 200, json: catalogPayload });
    const adapter = new FakeAdapter({ [FILE]: V1 });
    await loadPricingCacheFromFileForTests(adapter as unknown as DataAdapter, FILE);
    await waitForCatalogFetchForTests();
    expect(requestUrl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CATALOG_RETRY_DELAYS_MS[0]);
    await waitForCatalogFetchForTests();
    expect(requestUrl).toHaveBeenCalledTimes(2);
    const written = JSON.parse(adapter.files.get(FILE) ?? "{}") as { version?: number; models: Record<string, { im?: number }> };
    expect(written.version).toBe(2);
    expect(written.models["deepseek/deepseek-v4-pro"]?.im).toBe(0);
    expect(modelCatalogStatus()).toMatchObject({ outdated: false, lastError: null, failedAttempts: 0 });
    // A known text-only model stays text-only.
    expect(buildModel(config("deepseek/deepseek-v4-pro")).input).toEqual(["text"]);
  });

  it("OpenAI-compatible and Ollama always allow images; the provider answers", () => {
    expect(buildModel(config("any-model", "openai-compatible")).input).toEqual(["text", "image"]);
    expect(buildModel(config("llava", "ollama")).input).toEqual(["text", "image"]);
  });
});
