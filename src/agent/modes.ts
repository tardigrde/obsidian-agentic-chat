import { MUTATING_TOOLS } from "../tools/vault-tools";
import { type ApprovalPolicy, type ApprovalSettings, resolvePolicy } from "./approval";

/**
 * What the agent is *allowed to do* this turn — a preset over the approval system
 * plus a system-prompt framing. Distinct from output styles (how it talks) and
 * from skills (reusable capabilities).
 */
export type AgentMode = "agent" | "ask" | "plan";

export const DEFAULT_MODE: AgentMode = "agent";

/** Display order for menus and the composer dropdown (default first). */
export const MODE_ORDER: AgentMode[] = ["agent", "ask", "plan"];

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
  agent: {
    id: "agent",
    label: "Agent",
    icon: "bot",
    description: "Read and write the vault, gated by your approval settings.",
    promptOverlay: "",
  },
  ask: {
    id: "ask",
    label: "Ask",
    icon: "eye",
    description: "Read-only. The agent answers and explains but cannot change the vault.",
    promptOverlay:
      "You are in **ask mode**: strictly read-only. You may read, search, and list notes, " +
      "but you must not write, edit, rename, or delete anything. If the user asks for a change, " +
      "describe exactly what you would do instead of attempting it.",
  },
  plan: {
    id: "plan",
    label: "Plan",
    icon: "clipboard-list",
    description: "Investigate, then propose a step-by-step plan before any writes.",
    promptOverlay:
      "You are in **plan mode**: gather the information you need, then present a concrete, " +
      "step-by-step plan before making any changes. Do not write, edit, rename, or delete notes " +
      "yet — wait for the user to approve the plan (they will switch to Agent mode to carry it out).",
  },
};

export interface ModeDecision {
  policy: ApprovalPolicy;
  /** Set when the mode itself forces a denial, so the gate can explain why to the model. */
  reason?: string;
}

/**
 * Resolve how a tool call is gated under a mode. In ask/plan mode every mutating
 * tool is denied with a mode-specific note (which reaches the model via the
 * `beforeToolCall` gate); otherwise the configured approval policy applies.
 */
export function resolveModePolicy(
  mode: AgentMode,
  approval: ApprovalSettings,
  toolName: string,
): ModeDecision {
  if (mode !== "agent" && MUTATING_TOOLS.has(toolName)) {
    return { policy: "deny", reason: modeDenyReason(mode, toolName) };
  }
  return { policy: resolvePolicy(approval, toolName) };
}

function modeDenyReason(mode: AgentMode, toolName: string): string {
  if (mode === "ask") {
    return (
      `Ask mode is read-only, so the "${toolName}" tool is blocked. ` +
      "Tell the user what change you would make instead of trying to make it."
    );
  }
  return (
    `Plan mode is on, so the "${toolName}" tool is blocked. ` +
    "Finish gathering context and present a step-by-step plan; the user will switch to Agent mode to apply it."
  );
}
