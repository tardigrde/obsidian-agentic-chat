import type { App, DataAdapter } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { PLUGIN_ID } from "../constants";
import { containsSensitiveText } from "../privacy/redaction";
import {
  appendDailyEntry,
  formatDailyEntry,
  memorySettingsOf,
  resolveMemoryPaths,
  todayKey,
  VAULT_MEMORY_PROMPT_VERSION,
  type ResolvedMemoryPaths,
} from "../memory/vault-memory";

const RememberMemoryParameters = Type.Object({
  text: Type.String({ description: "fact, preference, or decision to remember (one concise sentence)" }),
  kind: Type.Optional(Type.String({ description: "preference|fact|instruction|summary" })),
});

export interface MemoryToolsOptions {
  adapter?: DataAdapter;
  getSettings?: () => { memory?: { enabled: boolean; store: "plugin" | "vault"; vaultFolder: string; modelOverride: string } };
}

export function createMemoryTools(app: App, options: MemoryToolsOptions = {}): AgentTool[] {
  const adapter = options.adapter ?? app.vault.adapter;
  const getSettings = options.getSettings;
  return [createRememberMemoryTool(app, adapter, getSettings)];
}

function createRememberMemoryTool(
  app: App,
  adapter: DataAdapter | undefined,
  getSettings?: MemoryToolsOptions["getSettings"],
): AgentTool<typeof RememberMemoryParameters> {
  return {
    name: "remember_memory",
    label: "Remember",
    description:
      "Save a durable fact/preference/decision to today's daily memory note. " +
      "Daily notes only — never writes MEMORY.md (distillation owns that). " +
      "Use when the user says 'remember this'.",
    parameters: RememberMemoryParameters,
    execute: async (_id, params) => {
      const settings = memorySettingsOf({ memory: getSettings?.().memory });
      if (!settings.enabled) throw new Error("Memory is disabled. Enable it in Settings → Agent → Memory.");
      const text = String(params.text ?? "").trim().replace(/\s+/g, " ");
      if (!text) throw new Error("text is required.");
      if (containsSensitiveText(text)) throw new Error("Memory text looks like it may contain a secret. Not saved.");
      if (!adapter) throw new Error("Vault adapter is unavailable.");
      const configDir = (app.vault as unknown as { configDir?: string }).configDir;
      const paths = resolveMemoryPaths(configDir, settings);
      const kind = typeof params.kind === "string" && params.kind.trim() ? params.kind.trim() : "fact";
      const entry = formatDailyEntry({
        date: todayKey(),
        bullets: [`[${kind}] ${text.endsWith(".") ? text : `${text}.`}`],
        note: `remembered via tool · v${VAULT_MEMORY_PROMPT_VERSION}`,
      });
      const dailyPath = await appendDailyEntry(adapter, paths, entry);
      await bumpPending(adapter, paths);
      return {
        content: [{ type: "text", text: `Saved to ${dailyPath}. Distillation to MEMORY.md runs automatically.` }],
        details: { kind: "memory", dailyPath, version: VAULT_MEMORY_PROMPT_VERSION, text },
      };
    },
  };
}

async function bumpPending(adapter: DataAdapter, paths: ResolvedMemoryPaths): Promise<void> {
  try {
    const { readDistillState, writeDistillState } = await import("../memory/vault-memory");
    const state = await readDistillState(adapter, paths);
    await writeDistillState(adapter, paths, { ...state, pending: state.pending + 1, lastAttempt: new Date().toISOString() });
  } catch {
    // Best-effort counter; distillation still triggers on mtime fallback.
  }
}

export function memoryPathForApp(app: App): string {
  return `${app.vault.configDir}/plugins/${PLUGIN_ID}/memory/memories.jsonl`;
}

/** Legacy path helper kept for the one-time JSONL → MEMORY.md migration. */
export function legacyMemoryPathForApp(app: App): string {
  return memoryPathForApp(app);
}
