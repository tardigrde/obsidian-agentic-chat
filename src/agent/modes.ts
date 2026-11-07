import { type ApprovalPolicy, type ApprovalSettings, resolvePolicy } from "./approval";

/**
 * What the agent is *allowed to do* this turn — a preset over the approval system.
 * Distinct from output styles (how it talks) and from skills (reusable capabilities).
 *
 * - `safe`  — honor the configured approval policy (per-tool overrides + `approval.mutating`).
 * - `yolo`  — session master auto-approve: force `mutating: "allow"`, but an explicit
 *             per-tool `"deny"` still wins.
 *
 * Precedence: slider (yolo) > per-tool override > settings default.
 */
export type AgentMode = "safe" | "yolo";

export const DEFAULT_MODE: AgentMode = "safe";

/** Display order for menus and pickers (default first). */
export const MODE_ORDER: AgentMode[] = ["safe", "yolo"];

/** The two postures exposed as the composer toggle (Safe ↔ YOLO). Kept as toggle contract; dropdown uses MODE_ORDER. */
export const TOGGLE_MODES: AgentMode[] = ["safe", "yolo"];

export interface ModeDefinition {
  id: AgentMode;
  label: string;
  /** Lucide icon name for pickers. */
  icon: string;
  description: string;
}

export const MODES: Record<AgentMode, ModeDefinition> = {
  safe: {
    id: "safe",
    label: "Safe",
    icon: "shield-check",
    description: "Honor your approval settings — mutating tools follow the configured gate.",
  },
  yolo: {
    id: "yolo",
    label: "YOLO",
    icon: "zap",
    description: "Auto-approve every mutating tool for this session (an explicit per-tool deny still wins).",
  },
};

export interface ModeDecision {
  policy: ApprovalPolicy;
  /** Set when the mode itself forces a denial, so the gate can explain why to the model. */
  reason?: string;
}

/**
 * Resolve how a tool call is gated under a mode. **YOLO** forces the mutating
 * default to `allow` (per-tool overrides still apply, so a per-tool `deny` wins).
 * **Safe** defers entirely to the configured approval policy.
 */
export function resolveModePolicy(
  mode: AgentMode,
  approval: ApprovalSettings,
  toolName: string,
): ModeDecision {
  // YOLO is a session master switch: force the mutating default to allow, but let an
  // explicit per-tool override (e.g. a deliberate "deny") still take precedence.
  const effective: ApprovalSettings = mode === "yolo" ? { ...approval, mutating: "allow" } : approval;
  return { policy: resolvePolicy(effective, toolName) };
}

/** Heal a persisted/legacy mode value, mapping the retired ask/plan/agent set onto the new one. */
export function healMode(stored: string | undefined): AgentMode {
  // hasOwnProperty (not `in`) so a prototype key like "constructor"/"toString" isn't treated as a mode.
  if (stored && Object.prototype.hasOwnProperty.call(MODES, stored)) return stored as AgentMode;
  // Legacy modes: agent (full approval) → safe; ask (read-only) and plan → safe;
  // anything else → default.
  if (stored === "agent" || stored === "ask" || stored === "plan") return "safe";
  return DEFAULT_MODE;
}

/**
 * Single validation gate for every mode surface (settings dropdown,
 * composer Safe↔YOLO toggle). Returns an error message when the transition is
 * blocked, otherwise `null`.
 */
export function validateModeTransition(isStreaming: boolean): string | null {
  if (isStreaming) return "Can't switch mode while the agent is responding.";
  return null;
}

/**
 * Atomic mode update descriptor. Callers mutate `settings.mode` only after
 * validation passes, then persist once.
 */
export interface ModeTransition {
  nextMode: AgentMode;
}

/**
 * Compute the atomic `settings.mode` update for a validated transition. Pure,
 * so every UI (settings tab, composer toggle) produces the same state.
 */
export function resolveModeTransition(
  current: AgentMode,
  target: AgentMode,
): ModeTransition | null {
  if (current === target) return null;
  return { nextMode: target };
}
