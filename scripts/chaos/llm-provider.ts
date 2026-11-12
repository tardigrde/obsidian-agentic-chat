import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChaosGuardError } from "./monkey-core";

/**
 * Where live chaos runs send model calls.
 *
 * - `openrouter` (default): OpenRouter with `AGENTIC_CHAT_API_KEY`.
 * - `opencode-go`: the OpenCode Go subscription with `OPENCODE_GO_API_KEY`, or
 *   the `opencode-go` key opencode stores in its `auth.json`.
 * - `opencode`: the local `opencode run` CLI. The explorer and miner use it;
 *   the plugin under test still needs an OpenAI-compatible endpoint.
 */

export const CHAOS_LLMS = ["openrouter", "opencode-go", "opencode"] as const;
export type ChaosLlmName = (typeof CHAOS_LLMS)[number];

export type ChaosBackend = "http" | "opencode";

export type ChaosLlm = {
  name: ChaosLlmName;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Where the key came from, for the report. Never the key itself. */
  keySource: string;
  /** `opencode` runs a local CLI; the others use HTTP. */
  backend: ChaosBackend;
};

const DEFAULTS: Record<ChaosLlmName, { baseUrl: string; model: string }> = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4.1-flash" },
  "opencode-go": { baseUrl: "https://opencode.ai/inference/go/v1", model: "deepseek-v4.1-flash" },
  // A label for the report. The CLI ignores it.
  opencode: { baseUrl: "opencode://run", model: "opencode-go/deepseek-v4.1-flash" },
};

/** OpenCode Go asks clients to name themselves and keep one session id per run. */
export const CHAOS_USER_AGENT = "agentic-chat-chaos/1.0";

export function parseLlmName(value: string | undefined): ChaosLlmName {
  const name = (value ?? "openrouter").trim().toLowerCase();
  if (!(CHAOS_LLMS as readonly string[]).includes(name)) {
    throw new ChaosGuardError(`--llm must be one of ${CHAOS_LLMS.join(", ")}, got ${value}`);
  }
  return name as ChaosLlmName;
}

function opencodeAuthKey(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const auth = JSON.parse(readFileSync(file, "utf8")) as Record<string, { key?: unknown }>;
    const key = auth["opencode-go"]?.key;
    return typeof key === "string" && key.trim() ? key.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function resolveChaosLlm(
  name: ChaosLlmName,
  env: NodeJS.ProcessEnv = process.env,
  authFile = path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
): ChaosLlm {
  const defaults = DEFAULTS[name];
  const model = env.AGENTIC_CHAT_CHAOS_MODEL?.trim() || defaults.model;
  if (name === "opencode") {
    // The CLI owns the login. Never read auth.json for this backend.
    return {
      name,
      baseUrl: defaults.baseUrl,
      model,
      apiKey: undefined,
      keySource: "opencode CLI login (no key read)",
      backend: "opencode",
    };
  }
  if (name === "openrouter") {
    return {
      name,
      baseUrl: env.AGENTIC_CHAT_BASE_URL?.trim() || defaults.baseUrl,
      model,
      apiKey: env.AGENTIC_CHAT_API_KEY?.trim() || undefined,
      keySource: "AGENTIC_CHAT_API_KEY",
      backend: "http",
    };
  }
  const fromEnv = env.OPENCODE_GO_API_KEY?.trim();
  return {
    name,
    baseUrl: env.OPENCODE_GO_BASE_URL?.trim() || defaults.baseUrl,
    model,
    apiKey: fromEnv || opencodeAuthKey(authFile),
    keySource: fromEnv ? "OPENCODE_GO_API_KEY" : "opencode auth.json (opencode-go)",
    backend: "http",
  };
}

/**
 * Endpoint for the plugin under test. It runs in Obsidian and cannot use the
 * local CLI, so `opencode` sends the plugin to OpenRouter.
 */
export function resolvePluginLlm(
  llm: ChaosLlm,
  env: NodeJS.ProcessEnv = process.env,
  keyFile?: string,
): { baseUrl: string; model: string; apiKey?: string; keySource: string } {
  // Key file handling stays in chaos-monkey.ts, which owns readKeyFile().
  void keyFile;
  if (llm.name !== "opencode") {
    return { baseUrl: llm.baseUrl, model: llm.model, apiKey: llm.apiKey, keySource: llm.keySource };
  }
  return {
    baseUrl: env.AGENTIC_CHAT_BASE_URL?.trim() || "https://openrouter.ai/api/v1",
    model: env.AGENTIC_CHAT_CHAOS_PLUGIN_MODEL?.trim() || "deepseek/deepseek-v4.1-flash",
    apiKey: env.AGENTIC_CHAT_API_KEY?.trim() || undefined,
    keySource: "AGENTIC_CHAT_API_KEY",
  };
}

/** Extra request headers for the explorer and miner. No secrets. */
export function llmHeaders(name: ChaosLlmName | undefined, sessionId: string): Record<string, string> {
  if (name !== "opencode-go") return {};
  return { "user-agent": CHAOS_USER_AGENT, "x-opencode-session": sessionId };
}
