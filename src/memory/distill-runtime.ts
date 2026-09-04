import type { DataAdapter } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { AgenticChatSettings } from "../settings-schema";
import { activeModelConfig, apiKeyForProvider } from "../settings-schema";
import { buildModel } from "../llm/models";
import { sharedAgentModels } from "../llm/providers";
import { loadMemoryRecords } from "./memory";
import {
  DISTILL_BACKOFF_MS,
  appendDailyEntry,
  appendDailySkipped,
  deterministicDistill,
  extractDailyBullets,
  formatDailyEntry,
  formatMemoryFile,
  memorySettingsOf,
  mergeAutoBullets,
  migrateLegacyRecords,
  parseMemoryFile,
  readDistillState,
  releaseDistillLock,
  resolveMemoryPaths,
  shouldCaptureSession,
  shouldDistillNow,
  todayKey,
  tryAcquireDistillLock,
  writeDistillState,
  writeMemoryFileAtomic,
  VAULT_MEMORY_PROMPT_VERSION,
  TIER2_DAILY_CHARS,
  MAX_TIER2_DAILIES,
  MAX_DISTILL_OUTPUT_TOKENS,
  type DistillFn,
  type ResolvedMemoryPaths,
} from "./vault-memory";

export interface VaultMemoryFlushResult {
  status: "appended" | "skipped" | "disabled" | "failed";
  dailyPath?: string;
  bullets?: number;
  reason?: string;
}

export interface VaultMemoryDistillResult {
  status: "distilled" | "skipped" | "disabled" | "failed" | "locked";
  version?: number;
  reason?: string;
}

/** Tier-1: deterministic daily append on session end. Zero tokens. */
export async function flushSessionToDaily(options: {
  adapter: DataAdapter;
  configDir?: string;
  settings: AgenticChatSettings;
  messages: readonly AgentMessage[];
  sessionId?: string;
  modelId?: string;
  now?: number;
}): Promise<VaultMemoryFlushResult> {
  const memory = memorySettingsOf(options.settings);
  if (!memory.enabled) return { status: "disabled" };
  const gate = shouldCaptureSession(options.messages);
  if (!gate.capture) {
    return { status: "skipped", reason: gate.reason };
  }
  try {
    const paths = resolveMemoryPaths(options.configDir, memory);
    await migrateLegacyOnce(options.adapter, paths);
    const bullets = extractDailyBullets(options.messages);
    if (bullets.length === 0) return { status: "skipped", reason: "no durable bullets" };
    const entry = formatDailyEntry({
      date: todayKey(options.now),
      sessionId: options.sessionId,
      model: options.modelId,
      bullets,
      note: `session capture · v${VAULT_MEMORY_PROMPT_VERSION}`,
    });
    const dailyPath = await appendDailyEntry(options.adapter, paths, entry, todayKey(options.now));
    const state = await readDistillState(options.adapter, paths);
    await writeDistillState(options.adapter, paths, {
      ...state,
      pending: state.pending + 1,
      lastAttempt: new Date(options.now ?? Date.now()).toISOString(),
    });
    return { status: "appended", dailyPath, bullets: bullets.length };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Tier-2: consolidate recent dailies into MEMORY.md. LLM when available, deterministic fallback. */
export async function distillDailyToMemory(options: {
  adapter: DataAdapter;
  configDir?: string;
  settings: AgenticChatSettings;
  sessionCostUsd?: number;
  force?: boolean;
  distiller?: DistillFn;
  now?: number;
}): Promise<VaultMemoryDistillResult> {
  const memory = memorySettingsOf(options.settings);
  if (!memory.enabled) return { status: "disabled" };
  const now = options.now ?? Date.now();
  // Spend-cap guard: never distill past the user's hard cap.
  const cap = options.settings.notifications.costCapUsd;
  if (cap > 0 && (options.sessionCostUsd ?? 0) >= cap) {
    return { status: "skipped", reason: "spend cap reached" };
  }
  const apiKey = apiKeyForProvider(options.settings, options.settings.provider);
  if (!apiKey && !options.distiller) {
    if (!options.force) {
      try {
        const paths = resolveMemoryPaths(options.configDir, memory);
        await appendDailySkipped(options.adapter, paths, "offline/no API key");
      } catch {
        // Best-effort audit line.
      }
      return { status: "skipped", reason: "missing API key" };
    }
    // Manual /memory distill with no key: deterministic merge (zero tokens).
  }
  const paths = resolveMemoryPaths(options.configDir, memory);
  const state = await readDistillState(options.adapter, paths);
  if (state.nextRetryAfter && Date.parse(state.nextRetryAfter) > now && !options.force) {
    return { status: "skipped", reason: "in backoff" };
  }
  let memoryMtime: number | null = null;
  try {
    if (await options.adapter.exists(paths.memoryFile)) {
      const stat = await options.adapter.stat(paths.memoryFile);
      memoryMtime = stat?.mtime ?? now;
    }
  } catch {
    memoryMtime = null;
  }
  if (!options.force && !shouldDistillNow(state, memoryMtime, now)) {
    return { status: "skipped", reason: "nothing pending" };
  }
  if (!(await tryAcquireDistillLock(options.adapter, paths, now))) {
    return { status: "locked", reason: "another distillation is running" };
  }
  try {
    await migrateLegacyOnce(options.adapter, paths);
    const dailies = await readRecentDailies(options.adapter, paths);
    const existing = await options.adapter.exists(paths.memoryFile)
      ? parseMemoryFile(await options.adapter.read(paths.memoryFile))
      : { human: "", autoBullets: [] as string[], version: state.version };
    let auto: string[];
    if (options.distiller) {
      auto = await options.distiller(dailies, existing.autoBullets);
    } else if (apiKey) {
      try {
        auto = await llmDistill(dailies, existing.autoBullets, options.settings, apiKey);
      } catch (error) {
        auto = await deterministicDistill(dailies, existing.autoBullets);
        if (isDistillEmpty(auto, existing.autoBullets)) {
          throw error;
        }
      }
    } else {
      auto = await deterministicDistill(dailies, existing.autoBullets);
    }
    const merged = mergeAutoBullets(existing.autoBullets, auto);
    const version = Math.max(state.version, existing.version) + 1;
    await writeMemoryFileAtomic(options.adapter, paths, existing.human, merged, version);
    await writeDistillState(options.adapter, paths, {
      version,
      pending: 0,
      lastSuccess: new Date(now).toISOString(),
      lastAttempt: new Date(now).toISOString(),
      nextRetryAfter: undefined,
      failCount: 0,
    });
    return { status: "distilled", version };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await writeDistillState(options.adapter, paths, {
      ...state,
      lastAttempt: new Date(now).toISOString(),
      nextRetryAfter: new Date(now + DISTILL_BACKOFF_MS).toISOString(),
      failCount: state.failCount + 1,
    });
    try {
      await appendDailySkipped(options.adapter, paths, `distill failed: ${reason}`);
    } catch {
      // Best-effort.
    }
    return { status: "failed", reason };
  } finally {
    await releaseDistillLock(options.adapter, paths);
  }
}

async function readRecentDailies(adapter: DataAdapter, paths: ResolvedMemoryPaths): Promise<string[]> {
  try {
    const listing = await adapter.list(paths.dailyDir);
    const files = listing.files.filter((file) => file.endsWith(".md")).sort().slice(-MAX_TIER2_DAILIES);
    const out: string[] = [];
    for (const file of files) {
      try {
        out.push((await adapter.read(file)).slice(0, TIER2_DAILY_CHARS));
      } catch {
        // Skip unreadable daily.
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function migrateLegacyOnce(adapter: DataAdapter, paths: ResolvedMemoryPaths): Promise<void> {
  try {
    if (await adapter.exists(paths.memoryFile)) return;
    if (!(await adapter.exists(paths.legacyFile))) return;
    const records = loadMemoryRecords(adapter, paths.legacyFile);
    const bullets = migrateLegacyRecords(records);
    if (bullets.length === 0) return;
    await adapter.write(paths.memoryFile, formatMemoryFile("", bullets, 1));
    // Orphan the legacy file with a rename-by-copy so no data is lost.
    try {
      await adapter.write(`${paths.legacyFile}.migrated`, await adapter.read(paths.legacyFile));
      await adapter.remove(paths.legacyFile);
    } catch {
      // Leave legacy in place if the copy fails.
    }
  } catch {
    // Best-effort migration; never blocks Tier-1/2.
  }
}

function isDistillEmpty(auto: string[], existing: string[]): boolean {
  return auto.length === 0 && existing.length === 0;
}

async function llmDistill(
  dailies: string[],
  oldAuto: string[],
  settings: AgenticChatSettings,
  apiKey: string,
): Promise<string[]> {
  const override = memorySettingsOf(settings).modelOverride.trim();
  const config = activeModelConfig(settings);
  const model: Model<"openai-completions"> = buildModel(override ? { ...config, modelId: override } : config);
  const prompt = [
    "Distill durable cross-session memory from recent daily notes.",
    "Return ONLY a Markdown bullet list (- one fact per line), max 30 bullets, each <= 200 chars.",
    "Keep user preferences, standing decisions, project facts, open threads. Drop chit-chat, transient paths, secrets.",
    "Be concise.",
    "",
    "<daily-notes>",
    dailies.join("\n\n---\n\n").slice(0, MAX_TIER2_DAILIES * TIER2_DAILY_CHARS),
    "</daily-notes>",
    "",
    "<existing-memory>",
    oldAuto.map((bullet) => `- ${bullet}`).join("\n"),
    "</existing-memory>",
  ].join("\n");
  const streamFn = sharedAgentModels();
  const responseStream = await streamFn.streamSimple(
    model,
    {
      systemPrompt: "You distill durable memory. Output only a Markdown bullet list.",
      messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
    },
    {
      maxTokens: MAX_DISTILL_OUTPUT_TOKENS,
      apiKey,
      headers: { "HTTP-Referer": "https://github.com/tardigrde/obsidian-agentic-chat", "X-Title": "Obsidian Agentic Chat" },
    },
  );
  const response = await responseStream.result();
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage || "distillation model call failed");
  }
  const text = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  const bullets = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean)
    .slice(0, 30);
  return mergeAutoBullets(oldAuto, bullets);
}
