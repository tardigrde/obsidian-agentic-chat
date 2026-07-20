import { type ApprovalPolicy, type ApprovalSettings, resolvePolicy } from "./approval";

/**
 * What the agent is *allowed to do* this turn — a preset over the approval system
 * plus a system-prompt framing. Distinct from output styles (how it talks) and
 * from skills (reusable capabilities).
 *
 * Collapsed to a single Safe ↔ YOLO posture plus a sticky read-only **plan** state:
 * - `safe`  — honor the configured approval policy (per-tool overrides + `approval.mutating`).
 * - `yolo`  — session master auto-approve: force `mutating: "allow"`, but an explicit
 *             per-tool `"deny"` still wins.
 * - `plan`  — read-only (deny every tool except a small allowlist) plus the plan-framing overlay.
 *             Entered with `/plan`. The model signals completion by ending a message
 *             with `PLAN_COMPLETE`; the user then clicks "Implement this plan" to exit.
 *
 * Precedence: plan > slider (yolo) > per-tool override > settings default.
 */
export type AgentMode = "safe" | "yolo" | "plan";

export const DEFAULT_MODE: AgentMode = "safe";

/** Display order for menus and pickers (default first; plan last — it's command-driven). */
export const MODE_ORDER: AgentMode[] = ["safe", "yolo", "plan"];

/** The two postures exposed as the composer toggle / settings default (plan is `/plan` only). */
export const TOGGLE_MODES: AgentMode[] = ["safe", "yolo"];

export interface ModeDefinition {
  id: AgentMode;
  label: string;
  /** Lucide icon name for pickers. */
  icon: string;
  description: string;
  /** Appended to the system prompt to frame the mode for the model. Empty for the default. */
  promptOverlay: string;
}

export const MODES: Record<AgentMode, ModeDefinition> = {
  safe: {
    id: "safe",
    label: "Safe",
    icon: "shield-check",
    description: "Honor your approval settings — mutating tools follow the configured gate.",
    promptOverlay: "",
  },
  yolo: {
    id: "yolo",
    label: "YOLO",
    icon: "zap",
    description: "Auto-approve every mutating tool for this session (an explicit per-tool deny still wins).",
    promptOverlay: "",
  },
  plan: {
    id: "plan",
    label: "Plan",
    icon: "clipboard-list",
    description: "Read-only: investigate, then propose a step-by-step plan before any writes. The model signals completion with PLAN_COMPLETE; click Implement to execute.",
    promptOverlay:
      "You are in **plan mode**: read-only. No tool calls are allowed — gather context from the " +
      "conversation history only. When your plan is final and ready for implementation, end your " +
      "message with the exact line `PLAN_COMPLETE`. Do not include this marker until the plan is " +
      "truly complete and you have gathered all necessary context.",
  },
};

export interface ModeDecision {
  policy: ApprovalPolicy;
  /** Set when the mode itself forces a denial, so the gate can explain why to the model. */
  reason?: string;
}

/**
 * Resolve how a tool call is gated under a mode. In **plan** mode every tool
 * that is not in the read-only allowlist is denied with a read-only note.
 * **YOLO** forces the mutating default to `allow` (per-tool overrides still
 * apply, so a per-tool `deny` wins). **Safe** defers entirely to the configured
 * approval policy.
 */
export function resolveModePolicy(
  mode: AgentMode,
  approval: ApprovalSettings,
  toolName: string,
): ModeDecision {
  if (mode === "plan" && !READONLY_TOOLS.has(toolName)) {
    return { policy: "deny", reason: planDenyReason(toolName) };
  }
  // YOLO is a session master switch: force the mutating default to allow, but let an
  // explicit per-tool override (e.g. a deliberate "deny") still take precedence.
  const effective: ApprovalSettings = mode === "yolo" ? { ...approval, mutating: "allow" } : approval;
  return { policy: resolvePolicy(effective, toolName) };
}

/** Tools permitted in plan mode (everything else is blocked). */
const READONLY_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "vault_inspect",
  "ls",
  "search",
  "find",
  "grep",
  "get_active_note",
  "get_backlinks",
  "get_links",
  "local_graph",
  "get_properties",
  "search_memory",
  "web_search",
  "fetch_url",
]);

function planDenyReason(toolName: string): string {
  return (
    `Plan mode is read-only, so the "${toolName}" tool is blocked. ` +
    "Finish gathering context and present a step-by-step plan; signal completion with PLAN_COMPLETE."
  );
}

/**
 * Enter the sticky plan state, remembering the posture to restore later. Returns
 * null when already in plan mode (nothing to do). Pure so the UI transition is testable.
 */
export function enterPlan(current: AgentMode): { mode: "plan"; previous: AgentMode } | null {
  return current === "plan" ? null : { mode: "plan", previous: current };
}

/** Leave plan mode, restoring the remembered posture (or the default when unknown). */
export function exitPlan(previous: AgentMode | null): AgentMode {
  return previous && previous !== "plan" ? previous : DEFAULT_MODE;
}

/** Heal a persisted/legacy mode value, mapping the retired ask/plan/agent set onto the new one. */
export function healMode(stored: string | undefined): AgentMode {
  // hasOwnProperty (not `in`) so a prototype key like "constructor"/"toString" isn't treated as a mode.
  if (stored && Object.prototype.hasOwnProperty.call(MODES, stored)) return stored as AgentMode;
  // Legacy modes: agent (full approval) → safe; ask (read-only) → plan; anything else → default.
  if (stored === "agent") return "safe";
  if (stored === "ask") return "plan";
  return DEFAULT_MODE;
}
