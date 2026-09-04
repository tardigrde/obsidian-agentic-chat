import type { DataAdapter } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgenticChatSettings } from "../settings";
import { containsSensitiveText } from "../privacy/redaction";
import {
  appendDailyEntry,
  bumpPendingAtomic,
  formatDailyEntry,
  memorySettingsOf,
  resolveMemoryPaths,
  todayKey,
  VAULT_MEMORY_PROMPT_VERSION,
} from "../memory/vault-memory";
import { distillDailyToMemory } from "../memory/distill-runtime";
import type { DistillFn } from "../memory/vault-memory";
import type { WorkflowRenderer } from "./workflow-renderer";

export interface MemoryWorkflowControllerOptions {
  adapter: DataAdapter;
  getSettings: () => AgenticChatSettings;
  configDir: string;
  /** Legacy/unused by add|distill; kept optional so old callers still typecheck. */
  messages?: () => readonly AgentMessage[];
  sessionSource?: () => string | undefined;
  sessionCostUsd?: () => number;
  renderer: WorkflowRenderer;
  /** Injected for tests; production distills via the chat model or deterministic fallback. */
  distiller?: DistillFn;
  now?: () => number;
}

export class MemoryWorkflowController {
  constructor(private readonly options: MemoryWorkflowControllerOptions) {}

  async run(arg: string): Promise<void> {
    this.options.renderer.clear();
    const [subcommand, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
    if (subcommand === "add") {
      await this.addManual(rest.join(" "));
      return;
    }
    if (subcommand === "distill") {
      await this.distillNow();
      return;
    }
    if (!subcommand) {
      this.options.renderer.error("Usage: /memory add <text> or /memory distill.");
      return;
    }
    this.options.renderer.error(`Unknown memory command "${subcommand}". Try /memory add <text> or /memory distill.`);
  }

  private settings() {
    return this.options.getSettings();
  }

  private paths() {
    return resolveMemoryPaths(this.options.configDir, memorySettingsOf(this.settings()));
  }

  private ensureEnabled(): boolean {
    if (memorySettingsOf(this.settings()).enabled) return true;
    this.options.renderer.error("Memory is disabled. Enable it in Settings → Agent → Memory.");
    return false;
  }

  private async addManual(raw: string): Promise<void> {
    if (!this.ensureEnabled()) return;
    const text = raw.trim().replace(/\s+/g, " ");
    if (!text) {
      this.options.renderer.error("Usage: /memory add <text>");
      return;
    }
    if (containsSensitiveText(text)) {
      this.options.renderer.error("Memory text looks like it may contain a secret. Not saved.");
      return;
    }
    const entry = formatDailyEntry({
      date: todayKey(this.now()),
      bullets: [text.endsWith(".") ? text : `${text}.`],
      note: `manual /memory add · v${VAULT_MEMORY_PROMPT_VERSION}`,
    });
    try {
      const dailyPath = await appendDailyEntry(this.options.adapter, this.paths(), entry, todayKey(this.now()));
      // Manual entries must consolidate like any other Tier-1 input.
      try {
        await bumpPendingAtomic(this.options.adapter, this.paths());
      } catch {
        // Best-effort counter; distillation still triggers on mtime fallback.
      }
      this.options.renderer.info("Memory", [[dailyPath, "Saved to today's daily note."]]);
    } catch (error) {
      this.options.renderer.error(`Could not save memory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async distillNow(): Promise<void> {
    if (!this.ensureEnabled()) return;
    try {
      const result = await distillDailyToMemory({
        adapter: this.options.adapter,
        configDir: this.options.configDir,
        settings: this.settings(),
        sessionCostUsd: this.options.sessionCostUsd?.(),
        force: true,
        distiller: this.options.distiller,
        now: this.now(),
      });
      if (result.status === "distilled") {
        const suffix = result.fallback ? " (deterministic fallback — model call failed)" : "";
        this.options.renderer.info("Memory", [["MEMORY.md", `Distilled (v${result.version}).${suffix}`]]);
      } else {
        this.options.renderer.info("Memory", [[result.status, result.reason ?? "Nothing distilled."]]);
      }
    } catch (error) {
      this.options.renderer.error(`Distillation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
