import { getPerToolApproval, type ApprovalPolicy, type ApprovalSettings } from "./approval";
import { resolveModePolicy, type AgentMode } from "./modes";

/**
 * One resolver for every tool-family ladder: vault tools, persistent skill
 * tools, recursive deletes, MCP tools, and subagent dispatch. Pure: every input
 * that the ladders used to read from settings arrives explicitly.
 */

interface BasePolicyQuery {
  mode: AgentMode;
  approval: ApprovalSettings;
}

export interface VaultPolicyQuery extends BasePolicyQuery {
  family: "vault";
  toolName: string;
  args: unknown;
}

export interface McpPolicyQuery extends BasePolicyQuery {
  family: "mcp";
  toolName: string;
  /** Approval configured on the MCP server, if any. */
  serverApproval?: ApprovalPolicy;
}

export interface SubagentPolicyQuery extends BasePolicyQuery {
  family: "subagent";
  /** True when any dispatched role's allowlist can reach a non-denied mutating tool. */
  canMutate: boolean;
  /** Set when a dispatched agent name does not exist. */
  unknownAgentReason?: string;
}

export type ApprovalPolicyQuery = VaultPolicyQuery | McpPolicyQuery | SubagentPolicyQuery;

export interface ApprovalPolicyDecision {
  policy: ApprovalPolicy;
  reason?: string;
}

const MCP_DENIED_REASON = (toolName: string): string =>
  `The "${toolName}" MCP tool is disabled by your MCP approval settings.`;

const SUBAGENT_DENIED_REASON = "Subagent dispatch is blocked because mutating tools are denied.";

export function resolveToolPolicy(query: ApprovalPolicyQuery): ApprovalPolicyDecision {
  switch (query.family) {
    case "vault":
      return resolveVaultPolicy(query);
    case "mcp":
      return resolveMcpPolicy(query);
    case "subagent":
      return resolveSubagentPolicy(query);
  }
}

function resolveVaultPolicy(query: VaultPolicyQuery): ApprovalPolicyDecision {
  const modeDecision = resolveModePolicy(query.mode, query.approval, query.toolName);
  if (modeDecision.policy === "deny" && modeDecision.reason) {
    return { policy: "deny", reason: modeDecision.reason };
  }
  // H8 load/unload mutates prompt overlay (persistent) — default to ask to prevent
  // auto-injection via indirect prompt injection (fetch_url -> load_skill evil).
  // create_skill persists a new vault package — same ask default.
  // Respects perTool override so user can set allow/deny explicitly.
  const isPersistentSkillTool =
    query.toolName === "load_skill" || query.toolName === "unload_skill" || query.toolName === "create_skill";
  const policy = isPersistentSkillTool
    ? (getPerToolApproval(query.approval, query.toolName) ?? "ask")
    : modeDecision.policy;
  // Recursive folder delete always asks, even when the mode would
  // auto-approve: bulk destruction needs a plain per-path confirmation.
  // An explicit per-tool "allow" for delete still counts as standing
  // consent; anything else (YOLO blanket allow included) routes to ask.
  const effectivePolicy =
    isRecursiveDeleteArgs(query.args) &&
    policy === "allow" &&
    getPerToolApproval(query.approval, query.toolName) !== "allow"
      ? "ask"
      : policy;
  return { policy: effectivePolicy, reason: modeDecision.reason };
}

function resolveMcpPolicy(query: McpPolicyQuery): ApprovalPolicyDecision {
  // S1: MCP respects the same Safe/YOLO mode overlay as vault tools.
  const modeCheck = resolveModePolicy(query.mode, query.approval, query.toolName);
  if (modeCheck.policy === "deny" && modeCheck.reason) {
    return { policy: "deny", reason: modeCheck.reason };
  }
  const perTool = getPerToolApproval(query.approval, query.toolName);
  const serverBase = query.serverApproval ?? "ask";
  const yoloServerBase = query.mode === "yolo" && serverBase !== "deny" ? "allow" : serverBase;
  const policy = perTool ?? yoloServerBase;
  return { policy, reason: policy === "deny" ? MCP_DENIED_REASON(query.toolName) : undefined };
}

function resolveSubagentPolicy(query: SubagentPolicyQuery): ApprovalPolicyDecision {
  const modeCheck = resolveModePolicy(query.mode, query.approval, "subagent");
  if (modeCheck.policy === "deny" && modeCheck.reason) {
    return { policy: "deny", reason: modeCheck.reason };
  }
  if (query.unknownAgentReason) return { policy: "deny", reason: query.unknownAgentReason };
  // No mutating tool in the dispatched role: delegation itself is safe.
  if (!query.canMutate) return { policy: "allow" };
  const policy = query.mode === "yolo" ? "allow" : query.approval.mutating;
  return { policy, reason: policy === "deny" ? SUBAGENT_DENIED_REASON : undefined };
}

/** True when the args request a recursive folder delete (bulk destruction). */
function isRecursiveDeleteArgs(args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    (args as { recursive?: unknown }).recursive === true
  );
}
