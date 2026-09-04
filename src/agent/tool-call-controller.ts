import type { App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgenticChatSettings } from "../settings";
import type { ApprovalAuditInput, CheckpointAuditInput } from "./action-audit-log";
import {
  createFileCheckpointFromUndo,
  restoreFileCheckpoint,
  type FileCheckpoint,
} from "./file-checkpoints";
import { type ApprovalPolicy, getPerToolApproval } from "./approval";
import { isMcpToolName, mcpServerIdFromToolName } from "../mcp/tools";
import { MUTATING_TOOLS } from "../tools/tool-contracts";
import {
  pendingSubagentErrorDetails,
  persistedSnapshot,
  SUBAGENT_TOOL_NAME,
  normalizeTasks,
  type SubagentChildStatus,
} from "../tools/subagent-tool";
import type { AgentRole } from "./subagents";
import { findAgentRole } from "./subagents";
import { resolveModePolicy } from "./modes";
import { resolveWorkingDirPolicy, toolTargetPaths } from "./working-dir";
import { UNDOABLE_TOOLS, captureUndo } from "./undo";
import { memorySettingsOf, resolveMemoryPaths, isMemoryPath } from "../memory/vault-memory";

/** A pending tool call the user must approve. */
export interface ToolApprovalRequest {
  toolName: string;
  label: string;
  args: unknown;
  /** Optional tab/session label for background approvals (shown in modal title). */
  sessionLabel?: string;
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
  getProfiles: () => AgentRole[];
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
  private readonly getProfiles: () => AgentRole[];
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
    // H2: memory files are system-managed. Only the distillation path (direct
    // adapter writes, not tools) may touch them — deny generic vault writes
    // even in YOLO, for parent and subagent calls alike.
    if (toolName !== "remember_memory") {
      const memory = memorySettingsOf(settings as { memory?: import("../memory/vault-memory").VaultMemorySettings });
      if (memory.enabled) {
        const configDir = (this.app.vault as unknown as { configDir?: string }).configDir;
        const paths = resolveMemoryPaths(configDir, memory);
        // Raw args (not toolTargetPaths): plugin-internal dot-paths are dropped
        // by normalizeVaultPath, but the vault tool layer rejects them anyway —
        // belt and suspenders so the denial reason names memory, even in YOLO.
        const targets = rawMemoryTargetPaths(args);
        if (targets.some((target) => isMemoryPath(target, paths))) {
          const reason = `Memory files under "${paths.dir}" are managed automatically (daily notes + distilled MEMORY.md). The agent cannot write them directly — use remember_memory for daily notes; distillation owns MEMORY.md.`;
          await this.auditApproval({ decision: "denied", toolCallId, toolName, label: this.labelForTool(toolName), args, reason });
          return { block: true, reason };
        }
      }
    }
    const modeDecision = resolveModePolicy(settings.mode, settings.approval, toolName);
    if (modeDecision.policy === "deny" && modeDecision.reason) {
      await this.auditApproval({ decision: "denied", toolCallId, toolName, label: this.labelForTool(toolName), args, reason: modeDecision.reason });
      return { block: true, reason: modeDecision.reason };
    }
    if (toolName === SUBAGENT_TOOL_NAME) return this.gateSubagentDispatch(settings, toolCallId, args);
    if (isMcpToolName(toolName)) return this.gateMcpToolCall(settings, toolCallId, toolName, args);
    const decision = modeDecision;
    const { reason } = decision;
    // Skill resources are vault-hosted plugin content — reads stay exempt from
    // the working-dir allow-list, but create_skill WRITES a new package and is
    // not exempt: scoped dirs must still route it through ask.
    const isSkillReadTool =
      toolName === "read_skill" ||
      toolName === "read_skill_file" ||
      toolName === "load_skill" ||
      toolName === "unload_skill";
    const scoped = settings.mode === "safe" && !isSkillReadTool;
    // H8 load/unload mutates prompt overlay (persistent) — default to ask to prevent
    // auto-injection via indirect prompt injection (fetch_url -> load_skill evil).
    // create_skill persists a new vault package — same ask default.
    // Respects perTool override so user can set allow/deny explicitly.
    const isPersistentSkillTool = toolName === "load_skill" || toolName === "unload_skill" || toolName === "create_skill";
    const basePolicy = isPersistentSkillTool ? (getPerToolApproval(settings.approval, toolName) ?? "ask") : decision.policy;
    // Working-dir boundary (C1/S2): in Safe mode, granted dirs auto-run inside and route
    // out-of-scope targets through ask. YOLO is a deliberate session-wide allow, and plan
    // already forces read-only, so the boundary only refines Safe.
    const policy = scoped
      ? resolveWorkingDirPolicy(settings.approval.workingDirs, args, basePolicy)
      : basePolicy;
    // Recursive folder delete always asks, even when the mode would
    // auto-approve: bulk destruction needs a plain per-path confirmation.
    // An explicit per-tool "allow" for delete still counts as standing
    // consent; anything else (YOLO blanket allow included) routes to ask.
    const effectivePolicy =
      isRecursiveDeleteArgs(args) && policy === "allow" && getPerToolApproval(settings.approval, toolName) !== "allow"
        ? "ask"
        : policy;
    const label = this.labelForTool(toolName);
    if (effectivePolicy === "allow") {
      await this.auditApproval({ decision: "auto-approved", toolCallId, toolName, label, args });
      return undefined;
    }
    if (effectivePolicy === "deny") {
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
    // S1: MCP now respects the same mode overlay as vault tools (plan deny, yolo allow)
    // and the same working-dir refinement for vault-path args. Previously this bypassed both,
    // allowing MCP to escape the safety boundary. Working-dir refinement is only applied
    // when args actually target vault paths (path/newPath) — pathless MCP calls don't span the vault.
    const modeCheck = resolveModePolicy(settings.mode, settings.approval, toolName);
    if (modeCheck.policy === "deny" && modeCheck.reason) {
      await this.auditApproval({ decision: "denied", toolCallId, toolName, label: this.labelForTool(toolName), args, reason: modeCheck.reason });
      return { block: true, reason: modeCheck.reason };
    }
    const perTool = getPerToolApproval(settings.approval, toolName);
    const serverApproval = this.resolveMcpServerApproval(settings, toolName);
    const serverBase = serverApproval ?? "ask";
    const yoloServerBase = settings.mode === "yolo" && serverBase !== "deny" ? "allow" : serverBase;
    const basePolicy = perTool ?? yoloServerBase;
    // Only refine by working dirs when the call actually targets vault paths;
    // most MCP tools are pathless and should not be forced through the vault allow-list.
    const hasVaultTargets = toolTargetPaths(args).length > 0;
    const scoped = settings.mode === "safe" && hasVaultTargets;
    const policy = scoped ? resolveWorkingDirPolicy(settings.approval.workingDirs, args, basePolicy) : basePolicy;
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
    const override = getPerToolApproval(settings.approval, toolName);
    if (override) return override;
    return this.resolveMcpServerApproval(settings, toolName) ?? "ask";
  }

  private resolveMcpServerApproval(settings: AgenticChatSettings, toolName: string): ApprovalPolicy | undefined {
    const serverId = mcpServerIdFromToolName(toolName);
    if (!serverId) return undefined;
    const state = settings.plugins.mcpState[serverId];
    if (state && state.approval) return state.approval;
    const server = settings.mcp.servers.find((candidate) => candidate.id === serverId);
    return server?.approval;
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
    // Unknown agents fail closed with a distinct audit: the dispatch never ran,
    // so it must not be logged as auto-approved (execute would throw unknown-agent).
    const unknown = normalizeTasks((args ?? {})).find((task) => !findAgentRole(this.getProfiles(), task.agent));
    if (unknown) {
      const available = this.getProfiles().map((candidate) => candidate.name).join(", ") || "(none)";
      const reason = `subagent: unknown agent "${unknown.agent.trim()}". Available: ${available}.`;
      await this.auditApproval({ decision: "denied", toolCallId, toolName: SUBAGENT_TOOL_NAME, args, reason });
      return { block: true, reason };
    }
    if (!this.dispatchCanMutate(settings, args)) {
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

  /** True when any dispatched role's allowlist includes a mutating tool that is not per-tool denied. */
  private dispatchCanMutate(settings: AgenticChatSettings, args: unknown): boolean {
    const tasks = normalizeTasks((args ?? {}));
    return tasks.some((task) => {
      const profile = findAgentRole(this.getProfiles(), task.agent);
      if (!profile) return false;
      return profile.toolAllowlist.some((name) => {
        // Child agents only ever receive vault + web + artifact + read-skill tools
        // (see AgentSubagentRuntime.createChildAgent) — never MCP/memory/load_skill.
        // Gating on those names here would false-trigger a deny prompt for a role
        // that lists them aspirationally, so only MUTATING_TOOLS counts.
        if (!MUTATING_TOOLS.has(name)) return false;
        // Per-tool deny means this mutating tool is effectively read-only for dispatch purposes.
        if (getPerToolApproval(settings.approval, name) === "deny") return false;
        return true;
      });
    });
  }
}

/**
 * Raw vault-target paths from tool args without vault normalization. Used only
 * for the memory write-boundary: normalized helpers drop plugin-internal
 * dot-paths (the tool layer rejects those separately), but the denial reason
 * should still name memory when the agent aims at it.
 */
function rawMemoryTargetPaths(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const paths: string[] = [];
  for (const field of ["path", "newPath"] as const) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") continue;
    paths.push(value.trim().replaceAll("\\", "/").replace(/^\/+/, ""));
  }
  return paths;
}

/** True when the args request a recursive folder delete (bulk destruction). */
function isRecursiveDeleteArgs(args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    (args as { recursive?: unknown }).recursive === true
  );
}
