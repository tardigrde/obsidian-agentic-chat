import type { AgentEvent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ObsidianSessionManager } from "../session/session-manager";
import { redactValue } from "../privacy/redaction";
import { diffLines, diffStat, diffTooLarge, type DiffStat } from "../vault/diff";
import type { UndoEntry } from "./undo";

export type ActionAuditCategory = "turn" | "tool_call" | "approval" | "checkpoint" | "compaction";
export type ActionAuditDecision = "requested" | "approved" | "denied" | "auto-approved";
export type ActionAuditEgressKind = "web" | "mcp";

export interface ActionAuditContext {
  provider?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
  now?: () => number;
}

export interface AgentActionAuditRecorderOptions {
  sessionManager: Pick<ObsidianSessionManager, "appendActionAuditEvent" | "hasActiveSession">;
  getContext: () => ActionAuditContext;
}

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

export interface ApprovalAuditInput {
  decision: ActionAuditDecision;
  toolCallId: string;
  toolName: string;
  label?: string;
  reason?: string;
  args?: unknown;
}

export interface CheckpointAuditInput {
  action?: ActionAuditCheckpointEvent["action"];
  toolCallId: string;
  toolName: string;
  undo: UndoEntry;
}

export interface ActionAuditFilter {
  category?: ActionAuditCategory;
  toolName?: string;
  decision?: ActionAuditDecision;
  egressKind?: ActionAuditEgressKind;
  touchedPath?: string;
}

const MAX_AUDIT_STRING_LENGTH = 500;
const MAX_AUDIT_ARRAY_LENGTH = 20;
const MAX_AUDIT_OBJECT_KEYS = 30;
const MAX_AUDIT_DEPTH = 4;

export class AgentActionAuditRecorder {
  constructor(private readonly options: AgentActionAuditRecorderOptions) {}

  async record(event: ActionAuditEvent): Promise<void> {
    if (!this.options.sessionManager.hasActiveSession()) return;
    await this.options.sessionManager.appendActionAuditEvent(event);
  }

  async recordAgentEvent(event: AgentEvent): Promise<void> {
    const auditEvent = buildActionAuditEventFromAgentEvent(event, this.options.getContext());
    if (auditEvent) await this.record(auditEvent);
  }

  async recordApproval(input: ApprovalAuditInput): Promise<void> {
    await this.record(buildApprovalAuditEvent(input, this.options.getContext()));
  }

  async recordCheckpoint(input: CheckpointAuditInput): Promise<void> {
    await this.record(buildCheckpointAuditEvent(input, this.options.getContext()));
  }
}

export function buildActionAuditEventFromAgentEvent(
  event: AgentEvent,
  context: ActionAuditContext = {},
): ActionAuditEvent | null {
  const timestamp = timestampOf(context.now);
  if (event.type === "agent_start") {
    return {
      category: "turn",
      action: "agent_start",
      timestamp,
      provider: context.provider,
      modelId: context.modelId,
      thinkingLevel: context.thinkingLevel,
    };
  }
  if (event.type === "agent_end") {
    return {
      category: "turn",
      action: "agent_end",
      timestamp,
      provider: context.provider,
      modelId: context.modelId,
      thinkingLevel: context.thinkingLevel,
    };
  }
  if (event.type === "tool_execution_start") {
    return {
      category: "tool_call",
      action: "start",
      timestamp,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: redactAuditValue(event.args),
      touchedFiles: touchedFilesForTool(event.toolName, event.args),
      diff: diffSummaryForTool(event.toolName, event.args),
      egress: egressForTool(event.toolName, event.args),
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      category: "tool_call",
      action: "end",
      timestamp,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: redactAuditResult(event.result),
      isError: event.isError,
      touchedFiles: [],
      egress: egressForTool(event.toolName, undefined),
    };
  }
  return null;
}

export function buildApprovalAuditEvent(
  input: ApprovalAuditInput,
  context: ActionAuditContext = {},
): ActionAuditApprovalEvent {
  return {
    category: "approval",
    action: "decision",
    timestamp: timestampOf(context.now),
    decision: input.decision,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    label: input.label,
    reason: input.reason,
    args: redactAuditValue(input.args),
    touchedFiles: touchedFilesForTool(input.toolName, input.args),
    diff: diffSummaryForTool(input.toolName, input.args),
    egress: egressForTool(input.toolName, input.args),
  };
}

export function buildCheckpointAuditEvent(
  input: CheckpointAuditInput,
  context: ActionAuditContext = {},
): ActionAuditCheckpointEvent {
  return {
    category: "checkpoint",
    action: input.action ?? "captured",
    timestamp: timestampOf(context.now),
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    touchedFiles: touchedFilesForUndo(input.undo),
    undoKind: input.undo.kind,
    undoSummary: undoSummary(input.undo),
  };
}

export function filterActionAuditEvents(
  events: readonly ActionAuditEvent[],
  filter: ActionAuditFilter,
): ActionAuditEvent[] {
  return events.filter((event) => {
    if (filter.category && event.category !== filter.category) return false;
    if (filter.toolName && !("toolName" in event && event.toolName === filter.toolName)) return false;
    if (filter.decision && !(event.category === "approval" && event.decision === filter.decision)) return false;
    if (filter.egressKind && !("egress" in event && event.egress?.kind === filter.egressKind)) return false;
    if (filter.touchedPath && !("touchedFiles" in event && event.touchedFiles.includes(filter.touchedPath))) return false;
    return true;
  });
}

export function redactAuditValue(value: unknown): unknown {
  return redactValue(value, {
    maxLength: MAX_AUDIT_STRING_LENGTH,
    maxArrayLength: MAX_AUDIT_ARRAY_LENGTH,
    maxObjectKeys: MAX_AUDIT_OBJECT_KEYS,
    maxDepth: MAX_AUDIT_DEPTH,
    summarizeContent: true,
    redactHighEntropy: true,
  });
}

export function redactAuditResult(value: unknown): unknown {
  return redactValue(value, {
    maxLength: MAX_AUDIT_STRING_LENGTH,
    maxArrayLength: MAX_AUDIT_ARRAY_LENGTH,
    maxObjectKeys: MAX_AUDIT_OBJECT_KEYS,
    maxDepth: MAX_AUDIT_DEPTH,
    summarizeContent: false,
    redactHighEntropy: true,
  });
}

export function touchedFilesForTool(toolName: string, args: unknown): readonly string[] {
  const raw = args && typeof args === "object" ? (args as { path?: unknown; newPath?: unknown }) : {};
  const paths = [raw.path, raw.newPath].filter((path): path is string => typeof path === "string" && path.trim() !== "");
  if (paths.length === 0) return [];
  return [...new Set(paths.map(normalizePath))];
}

export function diffSummaryForTool(toolName: string, args: unknown): ActionAuditDiffSummary | undefined {
  const raw = extractToolArgs(args);
  const path = typeof raw.path === "string" ? normalizePath(raw.path) : undefined;
  switch (toolName) {
    case "write": return diffSummaryForWrite(raw, path);
    case "edit": return diffSummaryForEdit(raw, path);
    case "set_properties": return diffSummaryForSetProperties(raw, path);
    case "delete": return { kind: "delete", path };
    case "rename": return diffSummaryForRename(raw, path);
    default: return undefined;
  }
}

function extractToolArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" ? (args as Record<string, unknown>) : {};
}

function diffSummaryForWrite(raw: Record<string, unknown>, path: string | undefined): ActionAuditDiffSummary {
  const after = typeof raw.content === "string" ? raw.content : "";
  return { kind: "write", path, beforeCharLength: 0, afterCharLength: after.length };
}

function diffSummaryForEdit(raw: Record<string, unknown>, path: string | undefined): ActionAuditDiffSummary {
  return { kind: "edit", path, editCount: Array.isArray(raw.edits) ? raw.edits.length : 0 };
}

function diffSummaryForSetProperties(raw: Record<string, unknown>, path: string | undefined): ActionAuditDiffSummary {
  const properties = raw.properties && typeof raw.properties === "object" ? raw.properties : {};
  return { kind: "edit", path, editCount: Object.keys(properties).length };
}

function diffSummaryForRename(raw: Record<string, unknown>, path: string | undefined): ActionAuditDiffSummary {
  return {
    kind: "rename",
    from: path,
    to: typeof raw.newPath === "string" ? normalizePath(raw.newPath) : undefined,
  };
}

export function diffSummaryForContent(path: string, before: string, after: string): ActionAuditDiffSummary {
  if (diffTooLarge(before, after)) {
    return {
      kind: "edit",
      path: normalizePath(path),
      beforeCharLength: before.length,
      afterCharLength: after.length,
      lineDiffOmitted: true,
    };
  }
  return {
    kind: "edit",
    path: normalizePath(path),
    beforeCharLength: before.length,
    afterCharLength: after.length,
    stat: diffStat(diffLines(before, after)),
  };
}

function egressForTool(toolName: string, args: unknown): ActionAuditEgress | undefined {
  if (toolName === "web_search") return { kind: "web", target: stringField(args, "query") };
  if (toolName === "fetch_url") return { kind: "web", target: stringField(args, "url") };
  if (toolName.startsWith("mcp__")) return { kind: "mcp", target: toolName.split("__")[1] };
  return undefined;
}

function touchedFilesForUndo(undo: UndoEntry): readonly string[] {
  if (undo.kind === "rename") return [...new Set([undo.from, undo.to].map(normalizePath))];
  return [normalizePath(undo.path)];
}

function undoSummary(undo: UndoEntry): string {
  if (undo.kind === "rename") return `rename ${undo.to} back to ${undo.from}`;
  if (undo.kind === "delete") return `restore ${undo.path}`;
  if (undo.kind === "delete_folder") return `restore folder ${undo.path}`;
  return undo.before === null ? `remove ${undo.path}` : `restore prior contents of ${undo.path}`;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" ? truncateString(raw) : undefined;
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function truncateString(value: string): string {
  if (value.length <= MAX_AUDIT_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_AUDIT_STRING_LENGTH)}...[truncated ${value.length - MAX_AUDIT_STRING_LENGTH} chars]`;
}

function timestampOf(now: (() => number) | undefined): string {
  return new Date(now?.() ?? Date.now()).toISOString();
}
