import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { DiffStat } from "../vault/diff";
import type { UndoEntry } from "./undo";

/**
 * The audit event shapes. They live apart from the recorder so the session
 * writer can read and append entries without importing the agent side that
 * records them (#438). The recorder re-exports them for its callers.
 */

export type ActionAuditCategory = "turn" | "tool_call" | "approval" | "checkpoint" | "compaction";
export type ActionAuditDecision = "requested" | "approved" | "denied" | "auto-approved";
export type ActionAuditEgressKind = "web" | "mcp";

export interface ActionAuditEventBase {
  category: ActionAuditCategory;
  action: string;
  timestamp: string;
}

export interface ActionAuditTurnEvent extends ActionAuditEventBase {
  category: "turn";
  action: "agent_start" | "agent_end";
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface ActionAuditToolCallEvent extends ActionAuditEventBase {
  category: "tool_call";
  action: "start" | "end";
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  touchedFiles: readonly string[];
  diff?: ActionAuditDiffSummary;
  egress?: ActionAuditEgress;
}

export interface ActionAuditApprovalEvent extends ActionAuditEventBase {
  category: "approval";
  action: "decision";
  decision: ActionAuditDecision;
  toolCallId: string;
  toolName: string;
  label?: string;
  reason?: string;
  /** On a user approval: true for "Always allow", false for "Allow once". */
  remember?: boolean;
  args?: unknown;
  touchedFiles: readonly string[];
  diff?: ActionAuditDiffSummary;
  egress?: ActionAuditEgress;
}

export interface ActionAuditCheckpointEvent extends ActionAuditEventBase {
  category: "checkpoint";
  action: "captured" | "applied" | "failed";
  toolCallId: string;
  toolName: string;
  touchedFiles: readonly string[];
  undoKind: UndoEntry["kind"];
  undoSummary: string;
}

export interface ActionAuditCompactionEvent extends ActionAuditEventBase {
  category: "compaction";
  action: "start" | "end";
  trigger: "manual" | "auto";
  status?: "compacted" | "skipped";
  reason?: string;
  message?: string;
  messageCount: number;
  userTurns: number;
  estimatedTokens: number;
  contextWindow: number;
  replacementMessageCount?: number;
  hasInstructions?: boolean;
}

export type ActionAuditEvent =
  | ActionAuditTurnEvent
  | ActionAuditToolCallEvent
  | ActionAuditApprovalEvent
  | ActionAuditCheckpointEvent
  | ActionAuditCompactionEvent;

export interface ActionAuditDiffSummary {
  kind: "write" | "edit" | "delete" | "rename";
  path?: string;
  from?: string;
  to?: string;
  stat?: DiffStat;
  lineDiffOmitted?: boolean;
  editCount?: number;
  beforeCharLength?: number;
  afterCharLength?: number;
}

export interface ActionAuditEgress {
  kind: ActionAuditEgressKind;
  target?: string;
}
