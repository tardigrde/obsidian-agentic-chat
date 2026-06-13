import { MUTATING_TOOLS } from "../tools/vault-tools";

/** Per-tool gate: run freely, ask the user, or refuse outright. */
export type ApprovalPolicy = "allow" | "ask" | "deny";

export interface ApprovalSettings {
  /** Policy applied to mutating tools (write/edit/delete/rename) without an override. */
  mutating: ApprovalPolicy;
  /** Explicit per-tool overrides, keyed by tool name. */
  perTool: Record<string, ApprovalPolicy>;
}

export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = {
  mutating: "ask",
  perTool: {},
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
