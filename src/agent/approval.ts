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
  const override = getPerToolApproval(settings, toolName);
  if (override) return override;
  return MUTATING_TOOLS.has(toolName) ? settings.mutating : "allow";
}

const VALID_POLICIES: ReadonlySet<string> = new Set(["allow", "ask", "deny"]);

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return typeof value === "string" && VALID_POLICIES.has(value);
}

function isSafeKey(key: string): boolean {
  return key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

/**
 * Single writer for the shared perTool map — S1.
 * All vault + MCP renderers and approval-memory go through here so the map
 * cannot diverge (two renderers writing the same key).
 */
export function setPerToolApproval(
  settings: ApprovalSettings,
  toolName: string,
  policy: ApprovalPolicy | "default" | null | undefined,
): void {
  if (!isSafeKey(toolName)) return;
  if (policy == null || policy === "default") {
    delete settings.perTool[toolName];
    return;
  }
  if (!isApprovalPolicy(policy)) return;
  settings.perTool[toolName] = policy;
}

export function clearPerToolApproval(settings: ApprovalSettings, toolName: string): void {
  if (!isSafeKey(toolName)) return;
  delete settings.perTool[toolName];
}

export function getPerToolApproval(settings: ApprovalSettings, toolName: string): ApprovalPolicy | undefined {
  if (!isSafeKey(toolName)) return undefined;
  const value = settings.perTool[toolName];
  return isApprovalPolicy(value) ? value : undefined;
}

export function healPerToolMap(raw: unknown): Record<string, ApprovalPolicy> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ApprovalPolicy> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeKey(key)) continue;
    if (isApprovalPolicy(value)) out[key] = value;
  }
  return out;
}

export function clearMcpPerToolApprovals(approval: ApprovalSettings, serverId: string): Record<string, ApprovalPolicy> {
  // Mirrors src/settings.ts:localMcpToolName prefix logic without importing mcp/tools
  const prefix = `mcp__${serverId}__`;
  const removed: Record<string, ApprovalPolicy> = {};
  for (const key of Object.keys(approval.perTool)) {
    if (!key.startsWith(prefix)) continue;
    const value = getPerToolApproval(approval, key);
    if (value) removed[key] = value;
    clearPerToolApproval(approval, key);
  }
  return removed;
}
