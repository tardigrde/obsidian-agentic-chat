import type { App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgenticChatSettings } from "../settings";
import type { ApprovalAuditInput, CheckpointAuditInput } from "./action-audit-log";
import {
  createFileCheckpointFromUndo,
  restoreFileCheckpoint,
  type FileCheckpoint,
} from "./file-checkpoints";
import type { ApprovalPolicy } from "./approval";
import { isMcpToolName, mcpServerIdFromToolName } from "../mcp/tools";
import { MUTATING_TOOLS } from "../tools/tool-contracts";
import {
  pendingSubagentErrorDetails,
  persistedSnapshot,
  SUBAGENT_TOOL_NAME,
  normalizeTasks,
  type SubagentChildStatus,
} from "../tools/subagent-tool";
import type { AgentProfile } from "./subagents";
import { resolveModePolicy } from "./modes";
import { resolveWorkingDirPolicy } from "./working-dir";
import { UNDOABLE_TOOLS, captureUndo } from "./undo";

/** A pending tool call the user must approve. */
export interface ToolApprovalRequest {
  toolName: string;
  label: string;
  args: unknown;
}

export type ToolGateDecision = { block: true; reason: string } | undefined;

/** A user's decision on an approval prompt, with an optional deny reason. */
export interface UserApprovalChoice {
  approved: boolean;
  /** Persist this decision for the tool (sets a per-tool "allow" override). */
  remember: boolean;
  /** Optional reason the user typed when denying; echoed back to the agent. */
  reason?: string;
}

export interface BeforeToolCallContext {
  toolCall: {
    id: string;
    name: string;
  };
  args: unknown;
}

export interface AfterToolCallContext {
  toolCall: {
    id: string;
    name?: string;
  };
  isError: boolean;
  result?: { details?: unknown };
}

interface ToolCallControllerOptions {
  app: App;
  getSettings: () => AgenticChatSettings;
  confirmToolCall: (request: ToolApprovalRequest) => Promise<UserApprovalChoice>;
  getTools: () => AgentTool[];
  getProfiles: () => AgentProfile[];
  onUndoApplied: () => void;
  recordApproval?: (input: ApprovalAuditInput) => Promise<void> | void;
  recordCheckpoint?: (input: CheckpointAuditInput) => Promise<void> | void;
  recordFileCheckpoint?: (checkpoint: FileCheckpoint) => Promise<void> | void;
}

/**
 * Owns per-session tool-call policy state: approval gates, pending undo captures,
 * and the undo stack exposed by `/undo`.
 */
export class AgentToolCallController {
  private readonly app: App;
  private readonly getSettings: () => AgenticChatSettings;
  private readonly confirmToolCall: (request: ToolApprovalRequest) => Promise<UserApprovalChoice>;
  private readonly getTools: () => AgentTool[];
  private readonly getProfiles: () => AgentProfile[];
  private readonly onUndoApplied: () => void;
  private readonly recordApproval?: (input: ApprovalAuditInput) => Promise<void> | void;
  private readonly recordCheckpoint?: (input: CheckpointAuditInput) => Promise<void> | void;
  private readonly recordFileCheckpoint?: (checkpoint: FileCheckpoint) => Promise<void> | void;

  /** Reversible records of mutating tool calls, newest last (for undo-last-change). */
  private undoStack: FileCheckpoint[] = [];
  /** Undo records captured pre-execution, keyed by tool call id, pending success. */
  private pendingUndo = new Map<string, FileCheckpoint>();

  constructor(options: ToolCallControllerOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    this.confirmToolCall = options.confirmToolCall;
    this.getTools = options.getTools;
    this.getProfiles = options.getProfiles;
    this.onUndoApplied = options.onUndoApplied;
    this.recordApproval = options.recordApproval;
    this.recordCheckpoint = options.recordCheckpoint;
    this.recordFileCheckpoint = options.recordFileCheckpoint;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * Revert the most recent mutating tool call (write/edit/rename/delete) this
   * session. Undo state is in-memory, so it doesn't survive a reload or rewind.
   */
  async undoLastChange(): Promise<string> {
    const checkpoint = this.undoStack.pop();
    if (!checkpoint) return "Nothing to undo.";
    const result = await restoreFileCheckpoint(this.app, checkpoint);
    if (result.ok) {
      this.onUndoApplied();
      return result.summary;
    }
    // Restore the checkpoint so the user can retry or inspect; report the failure.
    this.undoStack.push(checkpoint);
    return result.summary;
  }

  clearSessionState(): void {
    this.undoStack = [];
    this.pendingUndo.clear();
    pendingSubagentErrorDetails.clear();
  }

  async beforeToolCall(context: BeforeToolCallContext): Promise<ToolGateDecision> {
    const decision = await this.gateToolCall(context.toolCall.id, context.toolCall.name, context.args);
    // Capture the inverse only for allowed mutating calls; a blocked call never
    // runs, so it has nothing to undo.
    if (!decision && UNDOABLE_TOOLS.has(context.toolCall.name)) {
      const entry = await captureUndo(this.app, context.toolCall.name, context.args);
      if (entry) {
        const checkpoint = createFileCheckpointFromUndo({
          toolCallId: context.toolCall.id,
          toolName: context.toolCall.name,
          undo: entry,
        });
        this.pendingUndo.set(context.toolCall.id, checkpoint);
        await this.recordFileCheckpoint?.(checkpoint);
        await this.recordCheckpoint?.({
          toolCallId: context.toolCall.id,
          toolName: context.toolCall.name,
          undo: entry,
        });
      }
    }
    return decision;
  }

  async afterToolCall(
    context: AfterToolCallContext,
  ): Promise<{ details?: unknown; isError?: boolean } | undefined> {
    const entry = this.pendingUndo.get(context.toolCall.id);
    if (entry) {
      this.pendingUndo.delete(context.toolCall.id);
      // Only record successful mutations; a failed tool left nothing to undo.
      if (!context.isError) this.undoStack.push(entry);
    }
    // Error-path subagent dispatches throw, so the harness's error `toolResult`
    // would otherwise have empty `details` — inject the persisted dispatch card
    // so reload can rehydrate it. The live path already rendered via `onUpdate`.
    if (context.isError) {
      const pending = pendingSubagentErrorDetails.get(context.toolCall.id);
      if (pending) {
        pendingSubagentErrorDetails.delete(context.toolCall.id);
        return { details: pending };
      }
    }
    // Bounded persistence: strip live-only `transcript`/`stopId` from the
    // success-path `toolResult.details` so JSONL stays small. Live
    // `tool_execution_update` already showed the full transcript; the test
    // path `tool.execute` bypasses this hook, so its `stopId` assertion keeps
    // passing while persisted history is trimmed.
    const details = context.result?.details as
      | { kind?: string; children?: SubagentChildStatus[] }
      | undefined;
    if (details?.kind === "subagent" && Array.isArray(details.children)) {
      const needsStrip = details.children.some(
        (child) =>
          (child as unknown as Record<string, unknown>).transcript !== undefined ||
          (child as unknown as Record<string, unknown>).stopId !== undefined,
      );
      if (needsStrip) {
        return { details: persistedSnapshot(details.children) };
      }
    }
    return undefined;
  }

  private async gateToolCall(toolCallId: string, toolName: string, args: unknown): Promise<ToolGateDecision> {
    const settings = this.getSettings();
    const modeDecision = resolveModePolicy(settings.mode, settings.approval, toolName);
    if (modeDecision.policy === "deny" && modeDecision.reason) {
      await this.auditApproval({ decision: "denied", toolCallId, toolName, label: this.labelForTool(toolName), args, reason: modeDecision.reason });
      return { block: true, reason: modeDecision.reason };
    }
    if (toolName === SUBAGENT_TOOL_NAME) return this.gateSubagentDispatch(settings, toolCallId, args);
    if (isMcpToolName(toolName)) return this.gateMcpToolCall(settings, toolCallId, toolName, args);
    const decision = modeDecision;
    const { reason } = decision;
    // Working-dir boundary keys off path/newPath args, so only Safe mode (which can scope
    // calls to granted dirs) needs it; YOLO is a session-wide allow and plan is read-only.
    // Skill resources are vault-hosted plugin content, not user notes — exempt from the
    // working-dir allow-list so `read_skill*`/`load_skill` doesn't require an ask when dirs are scoped.
    const isSkillTool =
      toolName === "read_skill" ||
      toolName === "read_skill_file" ||
      toolName === "load_skill" ||
      toolName === "unload_skill";
    const scoped = settings.mode === "safe" && !isSkillTool;
    // H8 load/unload mutates prompt overlay (persistent) — default to ask to prevent
    // auto-injection via indirect prompt injection (fetch_url -> load_skill evil).
    // Respects perTool override so user can set allow/deny explicitly.
    const isLoadSkillTool = toolName === "load_skill" || toolName === "unload_skill";
    const basePolicy = isLoadSkillTool ? (settings.approval.perTool[toolName] ?? "ask") : decision.policy;
    // Working-dir boundary (C1/S2): in Safe mode, granted dirs auto-run inside and route
    // out-of-scope targets through ask. YOLO is a deliberate session-wide allow, and plan
    // already forces read-only, so the boundary only refines Safe.
    const policy = scoped
      ? resolveWorkingDirPolicy(settings.approval.workingDirs, args, basePolicy)
      : basePolicy;
    const label = this.labelForTool(toolName);
    if (policy === "allow") {
      await this.auditApproval({ decision: "auto-approved", toolCallId, toolName, label, args });
      return undefined;
    }
    if (policy === "deny") {
      const denial = reason ?? `The "${toolName}" tool is disabled by your approval settings.`;
      await this.auditApproval({ decision: "denied", toolCallId, toolName, label, args, reason: denial });
      return { block: true, reason: denial };
    }
    const choice = await this.confirmWithAudit(
      { toolName, label, args },
      toolCallId,
      "The user declined this action.",
    );
    return choice.approved
      ? undefined
      : { block: true, reason: choice.reason ?? "The user declined this action." };
  }

  private async gateMcpToolCall(
    settings: AgenticChatSettings,
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): Promise<ToolGateDecision> {
    const policy = this.resolveMcpPolicy(settings, toolName);
    const label = this.labelForTool(toolName);
    if (policy === "allow") {
      await this.auditApproval({ decision: "auto-approved", toolCallId, toolName, label, args });
      return undefined;
    }
    if (policy === "deny") {
      const reason = `The "${toolName}" MCP tool is disabled by your MCP approval settings.`;
      await this.auditApproval({ decision: "denied", toolCallId, toolName, label, args, reason });
      return { block: true, reason };
    }
    const choice = await this.confirmWithAudit(
      { toolName, label, args },
      toolCallId,
      "The user declined this MCP tool call.",
    );
    return choice.approved
      ? undefined
      : { block: true, reason: choice.reason ?? "The user declined this MCP tool call." };
  }

  private resolveMcpPolicy(settings: AgenticChatSettings, toolName: string): ApprovalPolicy {
    const override = settings.approval.perTool[toolName];
    if (override) return override;
    const serverId = mcpServerIdFromToolName(toolName);
    const server = settings.mcp.servers.find((candidate) => candidate.id === serverId);
    return server?.approval ?? "ask";
  }

  /**
   * Gate a subagent dispatch. The dispatch itself is only delegation; child tool
   * calls run through the same per-call controller hooks as parent calls. That
   * means working-dir boundaries, per-tool denies, approvals, checkpoints, and
   * undo capture happen at the actual child read/write, not as a blunt up-front
   * dispatch approval.
   */
  private async gateSubagentDispatch(
    settings: AgenticChatSettings,
    toolCallId: string,
    args: unknown,
  ): Promise<ToolGateDecision> {
    if (!this.dispatchCanMutate(args)) {
      await this.auditApproval({ decision: "auto-approved", toolCallId, toolName: SUBAGENT_TOOL_NAME, args });
      return undefined;
    }
    const policy = settings.mode === "yolo" ? "allow" : settings.approval.mutating;
    if (policy === "allow") {
      await this.auditApproval({ decision: "auto-approved", toolCallId, toolName: SUBAGENT_TOOL_NAME, args });
      return undefined;
    }
    if (policy === "deny") {
      const reason = "Subagent dispatch is blocked because mutating tools are denied.";
      await this.auditApproval({ decision: "denied", toolCallId, toolName: SUBAGENT_TOOL_NAME, args, reason });
      return { block: true, reason };
    }
    await this.auditApproval({ decision: "auto-approved", toolCallId, toolName: SUBAGENT_TOOL_NAME, args });
    return undefined;
  }

  private async confirmWithAudit(
    request: ToolApprovalRequest,
    toolCallId: string,
    deniedReason: string,
  ): Promise<UserApprovalChoice> {
    await this.auditApproval({
      decision: "requested",
      toolCallId,
      toolName: request.toolName,
      label: request.label,
      args: request.args,
    });
    const choice = await this.confirmToolCall(request);
    await this.auditApproval({
      decision: choice.approved ? "approved" : "denied",
      toolCallId,
      toolName: request.toolName,
      label: request.label,
      args: request.args,
      reason: choice.approved ? undefined : (choice.reason ?? deniedReason),
    });
    return choice;
  }

  private async auditApproval(input: ApprovalAuditInput): Promise<void> {
    await this.recordApproval?.(input);
  }

  private labelForTool(toolName: string): string {
    return this.getTools().find((candidate) => candidate.name === toolName)?.label ?? toolName;
  }

  /** True when any dispatched profile's allowlist includes a mutating tool. */
  private dispatchCanMutate(args: unknown): boolean {
    const tasks = normalizeTasks((args ?? {}));
    return tasks.some((task) => {
      const profile = this.getProfiles().find((candidate) => candidate.name === task.agent);
      return !!profile && profile.toolAllowlist.some((name) => MUTATING_TOOLS.has(name));
    });
  }
}
