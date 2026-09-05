import type { DataAdapter } from "obsidian";
import type { AgenticChatSettings } from "../settings";
import { findEligibleSessions, distillDailyToMemory } from "../memory/distill-runtime";
import { memorySettingsOf, readDistillState, resolveMemoryPaths } from "../memory/vault-memory";
import type { DistillFn } from "../memory/vault-memory";
import { PLUGIN_ID } from "../constants";

/** Quiet period before background distillation (activity resets the clock). */
export const IDLE_DISTILL_MS = 10 * 60 * 1000;
/** Minimum gap between boundary kicks (tab dances must not spam scans). */
const KICK_DEBOUNCE_MS = 30 * 1000;
/** Startup auto-distills at most one session; the rest wait for idle. */
const STARTUP_MAX_SESSIONS = 1;

export interface MemorySchedulerOptions {
  adapter: DataAdapter;
  configDir: string;
  getSettings: () => AgenticChatSettings;
  sessionCostUsd: () => number;
  /** True when no view is streaming anywhere (distillation never interrupts a turn). */
  isQuiet: () => boolean;
  isClosed: () => boolean;
  now?: () => number;
  /** Injected for tests; production distills via the chat model or deterministic fallback. */
  distiller?: DistillFn;
}

/**
 * Background distillation triggers: 10-min idle clock, session-boundary kicks,
 * and a mark-first startup sweep. Auto runs are silent (daily-note audit only);
 * the sync summary feeds /status. The distill lock serializes overlapping runs.
 */
export class MemoryScheduler {
  private timer: number | null = null;
  private lastKick = 0;
  private summary = "idle";
  private running = false;

  constructor(private readonly options: MemorySchedulerOptions) {}

  /** Startup: count eligible sessions, auto-distill at most one when quiet. */
  start(): void {
    void this.startupSweep();
    this.armIdle();
  }

  stop(): void {
    if (this.timer !== null) {
      try {
        globalThis.clearTimeout(this.timer);
      } catch {
        // Timer unavailable (tests); ignore.
      }
      this.timer = null;
    }
  }

  /** User/stream activity: restart the idle clock. */
  markActivity(): void {
    this.armIdle();
  }

  /** Session boundary (new/switch/load): scan soon, debounced. */
  kick(): void {
    const now = this.now();
    if (now - this.lastKick < KICK_DEBOUNCE_MS) return;
    this.lastKick = now;
    void this.runWorker();
  }

  /** Sync one-liner for /status (no I/O). */
  getSummary(): string {
    return this.summary;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private enabled(): boolean {
    try {
      return memorySettingsOf(this.options.getSettings()).enabled;
    } catch {
      return false;
    }
  }

  private armIdle(): void {
    this.stop();
    try {
      this.timer = Number(globalThis.setTimeout(() => {
        this.timer = null;
        void this.onIdle();
      }, IDLE_DISTILL_MS));
    } catch {
      // Timer unavailable (tests); skip.
    }
  }

  private async onIdle(): Promise<void> {
    if (this.options.isClosed() || !this.enabled()) return;
    if (!this.options.isQuiet()) {
      this.armIdle();
      return;
    }
    await this.runWorker();
    this.armIdle();
  }

  private async startupSweep(): Promise<void> {
    if (this.options.isClosed() || !this.enabled()) return;
    try {
      const paths = resolveMemoryPaths(this.options.configDir, memorySettingsOf(this.options.getSettings()));
      const state = await readDistillState(this.options.adapter, paths);
      const eligible = await findEligibleSessions(
        this.options.adapter,
        `${this.options.configDir}/plugins/${PLUGIN_ID}/sessions`,
        state,
        STARTUP_MAX_SESSIONS,
      );
      const explicit = state.pending > 0 ? 1 : 0;
      const waiting = eligible.length + explicit;
      this.summary = waiting > 0 ? `${waiting} session(s) awaiting distill` : "idle";
      if (waiting === 0 || !this.options.isQuiet()) return;
      await this.runWorker(STARTUP_MAX_SESSIONS);
    } catch {
      // Best-effort; idle will retry.
    }
  }

  private async runWorker(maxSessions?: number): Promise<void> {
    if (this.running || this.options.isClosed() || !this.enabled()) return;
    if (!this.options.isQuiet()) return;
    this.running = true;
    try {
      const result = await distillDailyToMemory({
        adapter: this.options.adapter,
        configDir: this.options.configDir,
        settings: this.options.getSettings(),
        sessionCostUsd: this.options.sessionCostUsd(),
        ...(maxSessions !== undefined ? { maxSessions } : {}),
        ...(this.options.distiller ? { distiller: this.options.distiller } : {}),
        now: this.now(),
      });
      if (result.status === "distilled") {
        this.summary = `distilled v${result.version ?? "?"} · ${new Date(this.now()).toISOString().slice(0, 10)}`;
      } else if (result.status !== "skipped" && result.status !== "locked") {
        this.summary = `last run ${result.status}: ${(result.reason ?? "").slice(0, 80)}`;
      }
    } catch {
      // Guards already audit; never surface background errors.
    } finally {
      this.running = false;
    }
  }
}
