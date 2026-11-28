import { getPerToolApproval, type ApprovalPolicy, type ApprovalSettings } from "./approval";
import { resolveModePolicy, type AgentMode } from "./modes";

/**
 * One resolver for every tool-family ladder: vault tools, MCP tools, and
 * subagent dispatch. Pure: every input that the ladders used to read from
 * settings arrives explicitly.
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

const SUBAGENT_DENIED_REASON = "Subagent dispatch is denied by your per-tool approval setting.";

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
  const policy = modeDecision.policy;
  // Recursive delete always asks unless that tool has an explicit per-tool allow.
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
  // Dispatch itself is delegation; the child's tool calls are gated where they
  // run. The only exception is an explicit per-tool deny of `subagent`.
  if (getPerToolApproval(query.approval, "subagent") === "deny") {
    return { policy: "deny", reason: SUBAGENT_DENIED_REASON };
  }
  return { policy: "allow" };
}

/** True when the args request a recursive folder delete (bulk destruction). */
function isRecursiveDeleteArgs(args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    (args as { recursive?: unknown }).recursive === true
  );
}
