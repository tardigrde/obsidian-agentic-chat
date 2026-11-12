import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { llmHeaders, parseLlmName, resolveChaosLlm, resolvePluginLlm } from "../scripts/chaos/llm-provider";
import { ChaosGuardError, assertChaosModel } from "../scripts/chaos/monkey-core";

const noAuth = path.join(os.tmpdir(), "missing-opencode-auth.json");

describe("chaos LLM endpoint choice", () => {
  it("defaults to OpenRouter with the shared key", () => {
    const llm = resolveChaosLlm(parseLlmName(undefined), { AGENTIC_CHAT_API_KEY: "or-key" }, noAuth);
    expect(llm).toEqual({
      name: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-v4.1-flash",
      apiKey: "or-key",
      keySource: "AGENTIC_CHAT_API_KEY",
      backend: "http",
    });
  });

  it("uses OpenCode Go with its own key, and the model passes the lock", () => {
    const llm = resolveChaosLlm("opencode-go", { OPENCODE_GO_API_KEY: "go-key", AGENTIC_CHAT_API_KEY: "or-key" }, noAuth);
    expect(llm).toMatchObject({ baseUrl: "https://opencode.ai/inference/go/v1", model: "deepseek-v4.1-flash", apiKey: "go-key" });
    expect(assertChaosModel(llm.model)).toBe("deepseek-v4.1-flash");
  });

  it("falls back to the opencode-go key in opencode's auth.json", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "chaos-auth-"));
    const file = path.join(dir, "auth.json");
    writeFileSync(file, JSON.stringify({ "opencode-go": { type: "api", key: "stored-key" } }));
    expect(resolveChaosLlm("opencode-go", {}, file)).toMatchObject({ apiKey: "stored-key", keySource: "opencode auth.json (opencode-go)" });
  });

  it("refuses unknown endpoints and sends Go headers only to Go", () => {
    expect(() => parseLlmName("chutes")).toThrow(ChaosGuardError);
    expect(llmHeaders("opencode-go", "s1")).toEqual({ "user-agent": "agentic-chat-chaos/1.0", "x-opencode-session": "s1" });
    expect(llmHeaders("openrouter", "s1")).toEqual({});
    expect(llmHeaders("opencode", "s1")).toEqual({});
  });

  it("uses the opencode CLI backend with no key and never reads auth.json", () => {
    const llm = resolveChaosLlm(
      parseLlmName("opencode"),
      { OPENCODE_GO_API_KEY: "go-key", AGENTIC_CHAT_API_KEY: "or-key" },
      noAuth,
    );
    expect(llm).toMatchObject({
      name: "opencode",
      baseUrl: "opencode://run",
      model: "opencode-go/deepseek-v4.1-flash",
      keySource: "opencode CLI login (no key read)",
      backend: "opencode",
    });
    expect(llm.apiKey).toBeUndefined();
  });

  it("resolves a plugin endpoint for the opencode backend", () => {
    const llm = resolveChaosLlm("opencode", {}, noAuth);
    expect(resolvePluginLlm(llm, { AGENTIC_CHAT_API_KEY: "or-key" })).toEqual({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "deepseek/deepseek-v4.1-flash",
      apiKey: "or-key",
      keySource: "AGENTIC_CHAT_API_KEY",
    });
    expect(
      resolvePluginLlm(llm, {
        AGENTIC_CHAT_BASE_URL: "https://gateway.example/api",
        AGENTIC_CHAT_CHAOS_PLUGIN_MODEL: "deepseek/deepseek-v4.1-flash-9",
        AGENTIC_CHAT_API_KEY: "k",
      }),
    ).toMatchObject({ baseUrl: "https://gateway.example/api", model: "deepseek/deepseek-v4.1-flash-9" });
  });

  it("keeps the plugin on the same endpoint for HTTP backends", () => {
    const openrouter = resolveChaosLlm("openrouter", { AGENTIC_CHAT_API_KEY: "or-key" }, noAuth);
    expect(resolvePluginLlm(openrouter)).toEqual({
      baseUrl: openrouter.baseUrl,
      model: openrouter.model,
      apiKey: "or-key",
      keySource: "AGENTIC_CHAT_API_KEY",
    });
    const go = resolveChaosLlm("opencode-go", { OPENCODE_GO_API_KEY: "go-key" }, noAuth);
    expect(resolvePluginLlm(go)).toMatchObject({ baseUrl: go.baseUrl, model: go.model, apiKey: "go-key" });
  });
});
