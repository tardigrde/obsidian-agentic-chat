import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_SYSTEM_PROMPT } from "../src/agent/default-system-prompt";
import { formatExternalWorkspaceForSystemPrompt } from "../src/agent/external-workspace-prompt";
import type { ExternalWorkspaceSettings } from "../src/settings";
import { createExternalWorkspaceTools } from "../src/tools/external-workspace";
import type { DogfoodManifest } from "./dogfood-core";
import type { ScriptedDogfoodSnapshot } from "./agentic-eval-core";

export const JUDGE_RUBRIC_VERSION = 1;

export interface JudgeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  proxyUrl?: string;
  timeoutMs: number;
  maxTokens: number;
}

export interface RedactedJudgeConfig {
  configured: boolean;
  baseUrl?: string;
  model?: string;
  hasApiKey: boolean;
  hasProxy: boolean;
  timeoutMs?: number;
  maxTokens?: number;
  missing: string[];
}

export interface JudgePacket {
  version: typeof JUDGE_RUBRIC_VERSION;
  caseId: string;
  dogfoodRunId: string;
  objective: string;
  deterministic: {
    invariantOk: boolean | null;
    invariantFindings: Array<{ severity: string; area: string; message: string }>;
    metrics: Record<string, unknown>;
    knownIntentionalNoise: string[];
  };
  conversation: {
    userPrompts: string[];
    assistantResponses: string[];
  };
  generatedNotes: Array<{
    path: string;
    excerpt: string;
  }>;
  trace: {
    duplicateToolStarts: Array<{ key: string; count: number }>;
    repeatedExternalPathActions: Array<{ key: string; count: number }>;
    approvalDenials: Array<{ key: string; count: number }>;
  };
  promptContext: {
    defaultSystemPromptExcerpt: string;
    externalWorkspaceOverlay: string;
    relevantToolDescriptions: Record<string, string>;
  };
  rubric: string[];
}

export interface JudgeVerdict {
  overallScore: number;
  pass: boolean;
  summary: string;
  scores: Record<string, number>;
  strengths: string[];
  issues: string[];
  promptRecommendations: string[];
}

export interface JudgeRunResult {
  verdict: JudgeVerdict;
  cacheHit: boolean;
  cacheKey: string;
  packet: JudgePacket;
  rawResponse: string;
}

export interface JudgeRequestOptions {
  config: JudgeConfig;
  packet: JudgePacket;
  cacheDir: string;
}

interface EnvSource {
  [key: string]: string | undefined;
}

interface SessionDigest {
  userPrompts: string[];
  assistantResponses: string[];
  approvalDenials: Array<{ key: string; count: number }>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 1_200;
const MAX_PACKET_TEXT_CHARS = 1_200;
const MAX_PROMPTS = 16;
const MAX_ASSISTANT_RESPONSES = 16;
const MAX_GENERATED_NOTES = 12;

export async function resolveJudgeConfig(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ config?: JudgeConfig; redacted: RedactedJudgeConfig }> {
  const envFile = await readDotEnv(path.join(options.cwd, ".env"));
  const merged: EnvSource = { ...envFile, ...(options.env ?? process.env) };
  const baseUrl = firstEnv(merged, "AGENTIC_EVAL_JUDGE_BASE_URL", "OPENWEBUI_BASE_URL");
  const model = firstEnv(merged, "AGENTIC_EVAL_JUDGE_MODEL", "OPENWEBUI_MODEL");
  const inlineApiKey = firstEnv(merged, "AGENTIC_EVAL_JUDGE_API_KEY", "OPENWEBUI_API_KEY");
  const keyFile = firstEnv(merged, "AGENTIC_EVAL_JUDGE_API_KEY_FILE", "OPENWEBUI_API_KEY_FILE");
  const apiKey = inlineApiKey || (keyFile ? await readSecretFile(keyFile) : undefined);
  const proxyUrl = firstEnv(
    merged,
    "AGENTIC_EVAL_JUDGE_HTTPS_PROXY",
    "AGENTIC_EVAL_JUDGE_HTTP_PROXY",
    "HTTPS_PROXY",
    "HTTP_PROXY",
  );
  const timeoutMs = positiveInteger(firstEnv(merged, "AGENTIC_EVAL_JUDGE_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS);
  const maxTokens = positiveInteger(firstEnv(merged, "AGENTIC_EVAL_JUDGE_MAX_TOKENS"), DEFAULT_MAX_TOKENS);
  const missing = [
    ...(baseUrl ? [] : ["AGENTIC_EVAL_JUDGE_BASE_URL or OPENWEBUI_BASE_URL"]),
    ...(model ? [] : ["AGENTIC_EVAL_JUDGE_MODEL or OPENWEBUI_MODEL"]),
    ...(apiKey ? [] : ["AGENTIC_EVAL_JUDGE_API_KEY, AGENTIC_EVAL_JUDGE_API_KEY_FILE, OPENWEBUI_API_KEY, or OPENWEBUI_API_KEY_FILE"]),
  ];

  const redacted: RedactedJudgeConfig = {
    configured: missing.length === 0,
    baseUrl,
    model,
    hasApiKey: Boolean(apiKey),
    hasProxy: Boolean(proxyUrl),
    timeoutMs,
    maxTokens,
    missing,
  };
  if (missing.length > 0 || !baseUrl || !model || !apiKey) return { redacted };
  return {
    config: {
      baseUrl,
      apiKey,
      model,
      proxyUrl,
      timeoutMs,
      maxTokens,
    },
    redacted,
  };
}

export async function buildJudgePacket(options: {
  caseId: string;
  dogfoodRunId: string;
  runDir: string;
  snapshot: ScriptedDogfoodSnapshot;
  manifest?: DogfoodManifest;
}): Promise<JudgePacket> {
  const sessionDigest = await readSessionDigest(path.join(options.runDir, "vault", ".obsidian", "plugins", "agentic-chat", "sessions"));
  const generatedNotes = options.manifest ? await readGeneratedNotes(options.runDir, options.manifest) : [];
  return {
    version: JUDGE_RUBRIC_VERSION,
    caseId: options.caseId,
    dogfoodRunId: options.dogfoodRunId,
    objective:
      "Evaluate the response and artifact quality of an Obsidian agentic chat dogfood run. " +
      "Use deterministic oracle results as evidence, but judge whether the user-facing behavior and created notes look useful, grounded, safe, and efficient.",
    deterministic: {
      invariantOk: options.snapshot.invariant?.ok ?? null,
      invariantFindings: options.snapshot.invariant?.findings ?? [],
      metrics: {
        ...(options.snapshot.invariant?.metrics ?? {}),
        aggregate: options.snapshot.trace?.aggregate ?? {},
      },
      knownIntentionalNoise: [
        "Some write/external_inspect tool errors are intentional approval-denial sad paths.",
        "The repeated external read of foreign-vault/Imported.md is intentional cache coverage.",
        "Repeated active-note inspection can be intentional when separate dogfood turns verify context boundaries.",
      ],
    },
    conversation: {
      userPrompts: sessionDigest.userPrompts,
      assistantResponses: sessionDigest.assistantResponses,
    },
    generatedNotes,
    trace: {
      duplicateToolStarts: mergeRepeated((options.snapshot.trace?.files ?? []).flatMap((file) => file.duplicateToolStarts ?? [])),
      repeatedExternalPathActions: mergeRepeated(
        (options.snapshot.trace?.files ?? []).flatMap((file) => file.repeatedExternalPathActions ?? []),
      ),
      approvalDenials: sessionDigest.approvalDenials,
    },
    promptContext: buildPromptContext(),
    rubric: [
      "taskCompletion: Did the run complete the requested workflow and produce useful outputs?",
      "groundedness: Are responses and notes grounded in vault/external evidence rather than unsupported claims?",
      "responseQuality: Are user-facing answers concise, clear, and actionable?",
      "toolEfficiency: Did tool use avoid redundant or wasteful calls except for intentional test probes?",
      "safety: Did approvals, denials, ignored paths, and external-root boundaries behave safely?",
      "noteQuality: Are generated notes well-structured for Obsidian, with useful frontmatter, links, and organization?",
    ],
  };
}

function buildPromptContext(): JudgePacket["promptContext"] {
  const externalSettings = staticExternalWorkspaceSettings();
  const tools = createExternalWorkspaceTools(externalSettings);
  return {
    defaultSystemPromptExcerpt: compactText(DEFAULT_SYSTEM_PROMPT, MAX_PACKET_TEXT_CHARS),
    externalWorkspaceOverlay: formatExternalWorkspaceForSystemPrompt(externalSettings),
    relevantToolDescriptions: Object.fromEntries(tools.map((tool) => [tool.name, tool.description ?? ""])),
  };
}

function staticExternalWorkspaceSettings(): ExternalWorkspaceSettings {
  return {
    enabled: true,
    rootPath: "/workspace/example",
    approval: "ask",
    honorGitignore: true,
    ignoredGlobs: "",
  };
}

export async function runJudge(options: JudgeRequestOptions): Promise<JudgeRunResult> {
  await mkdir(options.cacheDir, { recursive: true });
  const prompt = judgePrompt(options.packet);
  const cacheKey = judgeCacheKey({ model: options.config.model, prompt });
  const cachePath = path.join(options.cacheDir, `${cacheKey}.json`);
  if (await exists(cachePath)) {
    const cached = JSON.parse(await readFile(cachePath, "utf8")) as JudgeRunResult;
    return { ...cached, cacheHit: true };
  }

  const rawResponse = await requestJudge(options.config, prompt);
  const verdict = parseJudgeVerdict(rawResponse);
  const result: JudgeRunResult = {
    verdict,
    cacheHit: false,
    cacheKey,
    packet: options.packet,
    rawResponse,
  };
  await writeFile(cachePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

export function judgeCacheKey(input: { model: string; prompt: string }): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: JUDGE_RUBRIC_VERSION, model: input.model, prompt: input.prompt }))
    .digest("hex");
}

export function judgePrompt(packet: JudgePacket): string {
  return [
    "You are an evaluator for an Obsidian agentic chat plugin.",
    "Return only strict JSON with this shape:",
    '{"overallScore":number,"pass":boolean,"summary":string,"scores":{"taskCompletion":number,"groundedness":number,"responseQuality":number,"toolEfficiency":number,"safety":number,"noteQuality":number},"strengths":string[],"issues":string[],"promptRecommendations":string[]}',
    "Use scores from 1 to 5, where 5 is excellent. Penalize missing evidence. Do not include markdown fences.",
    "Treat explicitly listed intentional dogfood noise as expected unless it also harmed user-facing quality.",
    "",
    "Judge packet:",
    JSON.stringify(packet, null, 2),
  ].join("\n");
}

export function parseJudgeVerdict(raw: string): JudgeVerdict {
  const parsed = JSON.parse(extractJsonObject(raw)) as Partial<JudgeVerdict>;
  const scores = typeof parsed.scores === "object" && parsed.scores !== null ? parsed.scores : {};
  const verdict: JudgeVerdict = {
    overallScore: numberValue(parsed.overallScore, "overallScore"),
    pass: typeof parsed.pass === "boolean" ? parsed.pass : numberValue(parsed.overallScore, "overallScore") >= 4,
    summary: stringValue(parsed.summary, "summary"),
    scores: Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, numberValue(value, `scores.${key}`)])),
    strengths: stringArray(parsed.strengths),
    issues: stringArray(parsed.issues),
    promptRecommendations: stringArray(parsed.promptRecommendations),
  };
  return verdict;
}

async function requestJudge(config: JudgeConfig, prompt: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const requestInit: RequestInit & { dispatcher?: unknown } = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: "You are a strict but practical software QA evaluator. Return JSON only." },
          { role: "user", content: prompt },
        ],
        temperature: 0,
        max_tokens: config.maxTokens,
        stream: false,
      }),
      signal: controller.signal,
    };
    if (config.proxyUrl) requestInit.dispatcher = await proxyDispatcher(config.proxyUrl);
    const response = await fetch(chatCompletionsUrl(config.baseUrl), requestInit);
    const text = await response.text();
    if (!response.ok) throw new Error(`Judge request failed with HTTP ${response.status}: ${truncate(text, 500)}`);
    const payload = JSON.parse(text) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error(payload.error?.message ?? "Judge response did not include message content.");
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

async function proxyDispatcher(proxyUrl: string): Promise<unknown> {
  const undici = (await import("undici")) as { ProxyAgent: new (url: string) => unknown };
  return new undici.ProxyAgent(proxyUrl);
}

function chatCompletionsUrl(baseUrl: string): string {
  const normalized = normalizeOpenAICompatibleApiBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

function normalizeOpenAICompatibleApiBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "http://localhost:3000/api";
  try {
    const url = new URL(trimmed);
    if (url.pathname === "" || url.pathname === "/") {
      url.pathname = "/api";
      return url.toString().replace(/\/+$/, "");
    }
  } catch {
    // Keep relative or test-double URLs normalized only by trailing slashes.
  }
  return trimmed;
}

async function readSessionDigest(sessionDir: string): Promise<SessionDigest> {
  if (!(await exists(sessionDir))) return { userPrompts: [], assistantResponses: [], approvalDenials: [] };
  const files = (await readdir(sessionDir)).filter((name) => name.endsWith(".jsonl")).sort();
  const userPrompts: string[] = [];
  const assistantResponses: string[] = [];
  const approvalDenials = new Map<string, number>();

  for (const name of files) {
    const raw = await readFile(path.join(sessionDir, name), "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as {
        type?: string;
        message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
        event?: { category?: string; action?: string; toolName?: string; decision?: string; reason?: string };
      };
      if (entry.type === "message" && entry.message?.role === "user") {
        userPrompts.push(compactText(messageText(entry.message.content), MAX_PACKET_TEXT_CHARS));
      }
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const text = messageText(entry.message.content);
        if (text.trim()) assistantResponses.push(compactText(text, MAX_PACKET_TEXT_CHARS));
      }
      if (entry.type === "action_audit" && entry.event?.category === "approval" && entry.event.action === "decision" && entry.event.decision === "denied") {
        const key = `${entry.event.toolName ?? "(unknown)"}: ${entry.event.reason ?? "(none)"}`;
        approvalDenials.set(key, (approvalDenials.get(key) ?? 0) + 1);
      }
    }
  }

  return {
    userPrompts: userPrompts.slice(-MAX_PROMPTS),
    assistantResponses: assistantResponses.slice(-MAX_ASSISTANT_RESPONSES),
    approvalDenials: [...approvalDenials.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((left, right) => right.count - left.count),
  };
}

async function readGeneratedNotes(runDir: string, manifest: DogfoodManifest): Promise<JudgePacket["generatedNotes"]> {
  const notes: JudgePacket["generatedNotes"] = [];
  for (const expected of manifest.requiredGeneratedNotes.slice(0, MAX_GENERATED_NOTES)) {
    const notePath = path.join(runDir, "vault", expected.path);
    if (!(await exists(notePath))) continue;
    notes.push({
      path: expected.path,
      excerpt: compactText(await readFile(notePath, "utf8"), MAX_PACKET_TEXT_CHARS),
    });
  }
  return notes;
}

async function readDotEnv(envPath: string): Promise<EnvSource> {
  if (!(await exists(envPath))) return {};
  const raw = await readFile(envPath, "utf8");
  const values: EnvSource = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return values;
}

async function readSecretFile(filePath: string): Promise<string | undefined> {
  try {
    const text = await readFile(path.resolve(filePath), "utf8");
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

function unquoteEnvValue(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function firstEnv(env: EnvSource, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function mergeRepeated(items: Array<{ key: string; count: number }>): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.key, (counts.get(item.key) ?? 0) + item.count);
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((left, right) => right.count - left.count);
}

function messageText(content: Array<{ type?: string; text?: string }> | undefined): string {
  return (content ?? []).map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
}

function compactText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+\n/g, "\n").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars)}\n[truncated ${normalized.length - maxChars} chars]` : normalized;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return extractJsonObject(fenced[1]);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  throw new Error("Judge response did not contain a JSON object.");
}

function numberValue(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Judge response field ${name} must be a number.`);
  return value;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Judge response field ${name} must be a string.`);
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
