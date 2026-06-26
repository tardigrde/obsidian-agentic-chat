import { MUTATING_TOOLS } from "../tools/tool-contracts";

/** Per-tool gate: run freely, ask the user, or refuse outright. */
export type ApprovalPolicy = "allow" | "ask" | "deny";

export interface ApprovalSettings {
  /** Policy applied to mutating tools without an override. */
  mutating: ApprovalPolicy;
  /** Explicit per-tool overrides, keyed by tool name. */
  perTool: Record<string, ApprovalPolicy>;
  /**
   * Granted working directories (vault-relative folder paths). When non-empty, tool
   * calls targeting paths inside any granted dir auto-run, while targets outside every
   * granted dir route through the gate (ask) — even reads. Empty = today's behavior.
   * See `src/agent/working-dir.ts` (C1/S2).
   */
  workingDirs: string[];
}

export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = {
  mutating: "ask",
  perTool: {},
  workingDirs: [],
};

/**
 * Decide how a tool call should be gated. Read-only tools run freely unless an
 * explicit override says otherwise; mutating tools follow the mutating policy.
 */
export function resolvePolicy(settings: ApprovalSettings, toolName: string): ApprovalPolicy {
  const override = settings.perTool[toolName];
  if (override) return override;
  return MUTATING_TOOLS.has(toolName) ? settings.mutating : "allow";
}
