#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { envValue, loadEnvFileFromArgs } from "./live-env.mjs";

export { parseEnvFile } from "./live-env.mjs";

const DEFAULT_TURNS = 4;
const DEFAULT_PREFIX_CHARS = 16_000;
const DEFAULT_MAX_TOKENS = 16;
const DEFAULT_DELAY_MS = 1500;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MIN_CACHE_READ = 1;
const DEFAULT_REPORT_DIR = "logs/provider-cache-evals";

const CHECK_ONLY = process.argv.includes("--check");

function intEnv(name, fallback) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function readApiKey() {
  const inline = envValue(process.env, "OPENAI_COMPATIBLE_API_KEY", "OPENWEBUI_API_KEY");
  if (inline) return inline;

  const file = envValue(process.env, "OPENAI_COMPATIBLE_API_KEY_FILE", "OPENWEBUI_API_KEY_FILE");
  if (!file) return undefined;
  const value = readFileSync(file, "utf8").trim();
  return value || undefined;
}

function requiredConfig() {
  const baseUrl = envValue(process.env, "OPENAI_COMPATIBLE_BASE_URL", "OPENWEBUI_BASE_URL");
  const model = envValue(process.env, "OPENAI_COMPATIBLE_MODEL", "OPENWEBUI_MODEL");
  const apiKey = readApiKey();
  const missing = [];
  if (!apiKey) missing.push("OPENAI_COMPATIBLE_API_KEY or OPENAI_COMPATIBLE_API_KEY_FILE (fallback: OPENWEBUI_API_KEY or OPENWEBUI_API_KEY_FILE)");
  if (!baseUrl) missing.push("OPENAI_COMPATIBLE_BASE_URL (fallback: OPENWEBUI_BASE_URL)");
  if (!model) missing.push("OPENAI_COMPATIBLE_MODEL (fallback: OPENWEBUI_MODEL)");
  if (missing.length > 0) {
    throw new Error(`Missing live provider-cache eval inputs:\n- ${missing.join("\n- ")}`);
  }
  return { apiKey, baseUrl, model };
}

export function normalizeBaseUrl(baseUrl) {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  const url = new URL(normalized);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/api";
    return url.toString().replace(/\/+$/, "");
  }
  if (/\/chat\/completions$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/chat\/completions$/i, "");
    return url.toString().replace(/\/+$/, "");
  }
  return normalized;
}

export function chatCompletionsUrl(baseUrl) {
  return `${normalizeBaseUrl(baseUrl)}/chat/completions`;
}

export function buildStablePrefix(chars) {
  const lines = [
    "Agentic Chat live provider-cache eval stable prefix.",
    "Keep this block byte-for-byte identical across requests so provider prompt caching can key on it.",
    "The requested answer is intentionally tiny; the large stable prefix is the cacheable payload.",
  ];
  let i = 0;
  while (lines.join("\n").length < chars) {
    const id = String(i).padStart(4, "0");
    i += 1;
    lines.push(
      `CACHE-EVAL-${id}: active-note context delimiter <context> --- </context>; artifact manifest; external_inspect; cacheRead; cacheWrite; compacted summary; stable prefix line.`,
    );
  }
  return lines.join("\n").slice(0, chars);
}

export function parseUsage(rawUsage) {
  const usage = rawUsage && typeof rawUsage === "object" ? rawUsage : {};
  const promptTokens = numberValue(usage.prompt_tokens);
  const completionTokens = numberValue(usage.completion_tokens);
  const totalTokens = numberValue(usage.total_tokens);
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object" ? usage.prompt_tokens_details : {};
  const cacheRead = numberValue(details.cached_tokens) || numberValue(usage.prompt_cache_hit_tokens);
  const cacheWrite = numberValue(details.cache_write_tokens) || numberValue(usage.prompt_cache_creation_tokens);
  return {
    input: Math.max(0, promptTokens - cacheRead - cacheWrite),
    output: completionTokens,
    cacheRead,
    cacheWrite,
    totalTokens: totalTokens || promptTokens + completionTokens,
    raw: usage,
  };
}

export function numberValue(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function proxyForUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (shouldBypassProxy(parsed.hostname)) return undefined;
  const protocolProxy =
    parsed.protocol === "https:"
      ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
      : process.env.HTTP_PROXY || process.env.http_proxy;
  return (process.env.PROVIDER_CACHE_EVAL_PROXY || protocolProxy || process.env.ALL_PROXY || process.env.all_proxy)?.trim();
}

export function shouldBypassProxy(hostname) {
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "").trim();
  if (!noProxy) return false;
  const host = hostname.toLowerCase();
  return noProxy
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      const withoutPort = entry.split(":")[0];
      if (withoutPort.startsWith(".")) return host.endsWith(withoutPort);
      return host === withoutPort || host.endsWith(`.${withoutPort}`);
    });
}

async function fetchWithProxy(rawUrl, options) {
  const proxy = proxyForUrl(rawUrl);
  if (!proxy) return await fetch(rawUrl, options);
  try {
    const { fetch: undiciFetch, ProxyAgent } = await import("undici");
    return await undiciFetch(rawUrl, { ...options, dispatcher: new ProxyAgent(proxy.replace(/\/+$/, "")) });
  } catch (error) {
    throw new Error(
      `Provider cache eval could not use proxy ${proxy}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function postCompletion({ url, apiKey, model, stablePrefix, turn, timeoutMs, maxTokens }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchWithProxy(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [
          {
            role: "system",
            content: stablePrefix,
          },
          {
            role: "user",
            content: `Turn ${turn}: reply exactly CACHE-EVAL-${turn}.`,
          },
        ],
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const providerMessage = json && typeof json === "object" ? JSON.stringify(json).slice(0, 1000) : text.slice(0, 1000);
      throw new Error(`Provider returned HTTP ${response.status}: ${providerMessage}`);
    }
    const content = json?.choices?.[0]?.message?.content ?? "";
    return {
      turn,
      content: String(content).slice(0, 200),
      usage: parseUsage(json?.usage),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function summarize(results) {
  const aggregate = results.reduce(
    (acc, result) => {
      acc.input += result.usage.input;
      acc.output += result.usage.output;
      acc.cacheRead += result.usage.cacheRead;
      acc.cacheWrite += result.usage.cacheWrite;
      acc.totalTokens += result.usage.totalTokens;
      return acc;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  );
  const warmTurns = results.slice(1);
  const maxWarmCacheRead = Math.max(0, ...warmTurns.map((result) => result.usage.cacheRead));
  const warmCacheRead = warmTurns.reduce((sum, result) => sum + result.usage.cacheRead, 0);
  return { aggregate, maxWarmCacheRead, warmCacheRead };
}

function writeReport(reportDir, report) {
  mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(reportDir, `provider-cache-${stamp}.json`);
  const mdPath = join(reportDir, `provider-cache-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, renderMarkdown(report), "utf8");
  return { jsonPath, mdPath };
}

export function renderMarkdown(report) {
  const lines = [
    "# Provider Cache Live Eval",
    "",
    `- status: ${report.status}`,
    `- model: ${report.model}`,
    `- endpoint: ${report.endpoint}`,
    `- turns: ${report.turns}`,
    `- prefix chars: ${report.prefixChars}`,
    `- min warm cache read: ${report.minCacheRead}`,
    `- max warm cache read: ${report.summary.maxWarmCacheRead}`,
    `- warm cache read total: ${report.summary.warmCacheRead}`,
    "",
    "| Turn | Input | Cache read | Cache write | Output | Total |",
    "|---:|---:|---:|---:|---:|---:|",
  ];
  for (const result of report.results) {
    lines.push(
      `| ${result.turn} | ${result.usage.input} | ${result.usage.cacheRead} | ${result.usage.cacheWrite} | ${result.usage.output} | ${result.usage.totalTokens} |`,
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function reportStatus(summary, minCacheRead) {
  return summary.maxWarmCacheRead >= minCacheRead ? "pass" : "fail";
}

async function main() {
  const loadedEnvFile = loadEnvFileFromArgs({ fallbackEnvName: "PROVIDER_CACHE_EVAL_ENV_FILE" });
  if (CHECK_ONLY) {
    process.stdout.write("Live provider-cache eval configured.\n");
    return;
  }

  const config = requiredConfig();
  const turns = intEnv("PROVIDER_CACHE_EVAL_TURNS", DEFAULT_TURNS);
  const prefixChars = intEnv("PROVIDER_CACHE_EVAL_PREFIX_CHARS", DEFAULT_PREFIX_CHARS);
  const maxTokens = intEnv("PROVIDER_CACHE_EVAL_MAX_TOKENS", DEFAULT_MAX_TOKENS);
  const delayMs = intEnv("PROVIDER_CACHE_EVAL_DELAY_MS", DEFAULT_DELAY_MS);
  const timeoutMs = intEnv("PROVIDER_CACHE_EVAL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const minCacheRead = intEnv("PROVIDER_CACHE_EVAL_MIN_CACHE_READ", DEFAULT_MIN_CACHE_READ);
  const reportDir = process.env.PROVIDER_CACHE_EVAL_REPORT_DIR?.trim() || DEFAULT_REPORT_DIR;
  if (turns < 2) throw new Error("PROVIDER_CACHE_EVAL_TURNS must be at least 2");

  const endpoint = chatCompletionsUrl(config.baseUrl);
  const stablePrefix = buildStablePrefix(prefixChars);
  const startedAt = new Date().toISOString();
  const results = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    process.stdout.write(`provider-cache live eval: turn ${turn}/${turns}\n`);
    results.push(
      await postCompletion({
        url: endpoint,
        apiKey: config.apiKey,
        model: config.model,
        stablePrefix,
        turn,
        timeoutMs,
        maxTokens,
      }),
    );
    if (turn < turns) await sleep(delayMs);
  }

  const summary = summarize(results);
  const status = reportStatus(summary, minCacheRead);
  const report = {
    status,
    startedAt,
    envFileLoaded: loadedEnvFile ? true : undefined,
    finishedAt: new Date().toISOString(),
    model: config.model,
    endpoint,
    turns,
    prefixChars,
    minCacheRead,
    summary,
    results,
  };
  const paths = writeReport(reportDir, report);
  process.stdout.write(renderMarkdown(report));
  process.stdout.write(`Reports written:\n- ${paths.jsonPath}\n- ${paths.mdPath}\n`);

  if (status !== "pass") {
    throw new Error(
      `Provider cache eval failed: expected a warm turn with cacheRead >= ${minCacheRead}, got max ${summary.maxWarmCacheRead}.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
