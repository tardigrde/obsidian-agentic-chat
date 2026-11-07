import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Pure policy for the chaos-monkey driver.
 *
 * Keep every decision that a test can pin down in this module: cap parsing,
 * mode/target selection, the temp-vault guard, the stop rule, and redaction.
 * The runner and the in-app driver call it; they do not re-implement it.
 */

export const CHAOS_MODES = ["focused", "generic"] as const;
export type ChaosMode = (typeof CHAOS_MODES)[number];

export const CHAOS_TARGETS = ["composer", "settings", "notes", "mcp"] as const;
export type ChaosTarget = (typeof CHAOS_TARGETS)[number];

export type ChaosCaps = {
  /** Maximum driver actions. One action is one user-visible step. */
  maxSteps: number;
  /** Maximum wall-clock seconds from the first driver action. */
  maxSeconds: number;
  /** Maximum real or scripted model calls. */
  maxCalls: number;
  /** Estimated token budget, from prompt characters / 4 plus reported usage. */
  maxTokens: number;
};

export type ChaosSelection = {
  mode: ChaosMode;
  target?: ChaosTarget;
};

export const DEFAULT_CAPS: ChaosCaps = {
  maxSteps: 12,
  maxSeconds: 180,
  maxCalls: 6,
  maxTokens: 40_000,
};

/** A dry run cannot spend tokens, so it keeps the same shape but a small budget. */
export const DEFAULT_DRY_RUN_CAPS: ChaosCaps = {
  maxSteps: 8,
  maxSeconds: 120,
  maxCalls: 6,
  maxTokens: 0,
};

export const TEMP_PREFIX = "chaos-monkey-";
export const SEED_MARKER = ".chaos-monkey-seed";

export class ChaosGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChaosGuardError";
  }
}

function positiveInt(name: string, value: string | number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ChaosGuardError(`${name} must be a positive integer, got ${String(value)}`);
  }
  return parsed;
}

/**
 * Parse the hard caps. `0` is allowed only for `maxTokens` in a dry run, where
 * the caller passes an explicit dry-run default. Every other zero or negative
 * value is rejected, so a typo cannot remove the cap.
 */
export function parseCaps(
  input: Partial<Record<keyof ChaosCaps, string | number>>,
  base: ChaosCaps = DEFAULT_CAPS,
): ChaosCaps {
  return {
    maxSteps: input.maxSteps === undefined ? base.maxSteps : positiveInt("maxSteps", input.maxSteps),
    maxSeconds: input.maxSeconds === undefined ? base.maxSeconds : positiveInt("maxSeconds", input.maxSeconds),
    maxCalls: input.maxCalls === undefined ? base.maxCalls : positiveInt("maxCalls", input.maxCalls),
    maxTokens: input.maxTokens === undefined ? base.maxTokens : positiveInt("maxTokens", input.maxTokens),
  };
}

/** Select the mode. Focused mode needs a named target. */
export function selectMode(modeValue: string | undefined, targetValue: string | undefined): ChaosSelection {
  const mode = (modeValue ?? "focused").trim().toLowerCase() as ChaosMode;
  if (!CHAOS_MODES.includes(mode)) {
    throw new ChaosGuardError(`--mode must be one of ${CHAOS_MODES.join(", ")}, got ${modeValue}`);
  }

  if (targetValue !== undefined && targetValue !== "") {
    const target = targetValue.trim().toLowerCase() as ChaosTarget;
    if (!CHAOS_TARGETS.includes(target)) {
      throw new ChaosGuardError(`--target must be one of ${CHAOS_TARGETS.join(", ")}, got ${targetValue}`);
    }
    if (mode === "generic") {
      throw new ChaosGuardError("--target belongs to --mode focused; generic mode chooses its own surfaces");
    }
    return { mode, target };
  }

  if (mode === "focused") {
    throw new ChaosGuardError(`--mode focused needs --target (${CHAOS_TARGETS.join(", ")})`);
  }

  return { mode };
}

/**
 * Refuse anything that is not a fresh directory under the temp root with the
 * chaos prefix. This is the hard guard that keeps the driver out of a real
 * vault such as `~/MyTestVault`.
 */
export function assertSafeVaultPath(candidate: string, tempRoot: string = os.tmpdir()): string {
  if (!candidate.trim()) throw new ChaosGuardError("vault path is empty");

  const resolved = path.resolve(candidate);
  const root = path.resolve(tempRoot);
  const relative = path.relative(root, resolved);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ChaosGuardError(`refusing vault outside the temp root: ${resolved}`);
  }
  const segments = relative.split(path.sep);
  if (!segments.some((segment) => segment.startsWith(TEMP_PREFIX))) {
    throw new ChaosGuardError(`refusing vault without a ${TEMP_PREFIX} directory: ${resolved}`);
  }
  if (/(^|[/\\])(MyTestVault|\.obsidian)([/\\]|$)/i.test(resolved)) {
    throw new ChaosGuardError(`refusing a real Obsidian vault path: ${resolved}`);
  }

  return resolved;
}

/** The marker is written by the runner and must survive until cleanup. */
export function assertSeedMarker(markerPath: string, expected: string = "chaos-monkey"): void {
  let content: string;
  try {
    content = readFileSync(markerPath, "utf8");
  } catch {
    throw new ChaosGuardError(`refusing vault without a seed marker: ${markerPath}`);
  }
  if (content.trim() !== expected) {
    throw new ChaosGuardError(`refusing vault with an unexpected seed marker: ${markerPath}`);
  }
}

export const PLAN_VERSION = 1;

/**
 * Data contract between the runner and the in-app driver.
 * Secrets never enter this file; the driver reads the key from the environment.
 */
export type ChaosPlan = {
  version: typeof PLAN_VERSION;
  mode: ChaosMode;
  target?: ChaosTarget;
  caps: ChaosCaps;
  live: boolean;
  startedAt: number;
  outDir: string;
  cancelFile: string;
  /** Deterministic choice stream for generic mode. */
  seed: number;
  model: string;
  baseUrl: string;
  seededNotes: string[];
  mcpUrl?: string;
};

export type ChaosStopState = {
  startedAt: number;
  steps: number;
  calls: number;
  tokens: number;
  now?: number;
  canceled?: boolean;
};

export type ChaosStopDecision = { stop: false } | { stop: true; reason: string };

/** The single stop rule shared by the runner and the in-app driver. */
export function decideStop(caps: ChaosCaps, state: ChaosStopState): ChaosStopDecision {
  const now = state.now ?? Date.now();
  if (state.canceled) return { stop: true, reason: "canceled" };
  if (state.steps >= caps.maxSteps) return { stop: true, reason: "max-steps" };
  if ((now - state.startedAt) / 1000 >= caps.maxSeconds) return { stop: true, reason: "max-seconds" };
  if (state.calls >= caps.maxCalls) return { stop: true, reason: "max-calls" };
  if (state.tokens >= caps.maxTokens && caps.maxTokens > 0) return { stop: true, reason: "max-tokens" };
  return { stop: false };
}

/** Rough token estimate for prompt budget enforcement. */
export function estimateTokens(text: string, seconds = 0): number {
  return Math.ceil(text.length / 4) + Math.ceil(seconds * 4);
}

/** Remove every provided secret from a string. Never log the original. */
export function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let redacted = text;
  for (const secret of secrets) {
    const trimmed = secret?.trim();
    if (!trimmed || trimmed.length < 4) continue;
    redacted = redacted.split(trimmed).join("[redacted]");
  }
  return redacted;
}
