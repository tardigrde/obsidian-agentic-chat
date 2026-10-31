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
import {
  CACHED_ESCALATION,
  JEV_MAX_SCANS_PER_SESSION,
  JEV_SCAN_CACHE_MAX,
  JEV_SCAN_CACHE_TTL_MS,
  JEV_SCAN_READ_TOOLS,
  safeJsonPreview,
  scanToolArgsForInjection,
  shouldEscalateToAsk,
  type InjectionScan,
} from "./jev-injection";
import type { JevTransport } from "./jev-client";
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
  /**
   * Resolves the TypeSafe API key for the opt-in Jev injection guard
   * (e.g. from secretStorage). When absent, the guard resolves the
   * deprecated plaintext `settings.jev.apiKey` fallback and stays disabled
   * unless a key is present.
   */
  resolveJevApiKey?: () => Promise<string | undefined> | string | undefined;
  /** Test seam for the Jev transport (production uses Obsidian requestUrl). */
  jevTransport?: JevTransport;
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
  private readonly resolveJevApiKey?: () => Promise<string | undefined> | string | undefined;
  private readonly jevTransport?: JevTransport;
  /** Memoized scan verdicts (fail-open escalations), bounded + TTL'd. */
  private readonly jevScanCache = new Map<string, { flag: boolean; ts: number }>();
  private jevScans = 0;

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
    this.resolveJevApiKey = options.resolveJevApiKey;
    this.jevTransport = options.jevTransport;
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
    this.jevScanCache.clear();
    this.jevScans = 0;
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
      // Opt-in Jev injection guard: escalate auto-allowed calls with
      // high-confidence malicious args to ask. Fail-open (see jev-injection).
      const jevScan = await this.jevScanArgs(toolName, args);
      if (jevScan) {
        const note = `Jev injection guard escalated this auto-allowed call (signals: ${(jevScan.signals ?? []).join(",") || "n/a"}, confidence ${jevScan.confidence.toFixed(2)}).`;
        return this.confirmWithAudit(
          { toolName, label, args },
          toolCallId,
          "Blocked by the injection guard: the arguments look like prompt injection. The user declined this action.",
          note,
        ).then((choice) =>
          choice.approved
            ? undefined
            : { block: true as const, reason: choice.reason ?? "The user declined this action." },
        );
      }
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
      const jevScan = await this.jevScanArgs(toolName, args);
      if (jevScan) {
        const note = `Jev injection guard escalated this auto-allowed MCP call (signals: ${(jevScan.signals ?? []).join(",") || "n/a"}, confidence ${jevScan.confidence.toFixed(2)}).`;
        return this.confirmWithAudit(
          { toolName, label, args },
          toolCallId,
          "Blocked by the injection guard: the arguments look like prompt injection. The user declined this MCP tool call.",
          note,
        ).then((choice) =>
          choice.approved
            ? undefined
            : { block: true as const, reason: choice.reason ?? "The user declined this MCP tool call." },
        );
      }
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
      const jevScan = await this.jevScanArgs(SUBAGENT_TOOL_NAME, args);
      if (jevScan) {
        return this.confirmWithAudit(
          { toolName: SUBAGENT_TOOL_NAME, label: this.labelForTool(SUBAGENT_TOOL_NAME), args },
          toolCallId,
          "Blocked by the injection guard: the dispatch looks like prompt injection. The user declined this action.",
          `Jev injection guard escalated this auto-approved dispatch (signals: ${(jevScan.signals ?? []).join(",") || "n/a"}, confidence ${jevScan.confidence.toFixed(2)}).`,
        ).then((choice) =>
          choice.approved
            ? undefined
            : { block: true as const, reason: choice.reason ?? "The user declined this action." },
        );
      }
      await this.auditApproval({ decision: "auto-approved", toolCallId, toolName: SUBAGENT_TOOL_NAME, args });
      return undefined;
    }
    const policy = settings.mode === "yolo" ? "allow" : settings.approval.mutating;
    if (policy === "allow") {
      const jevScan = await this.jevScanArgs(SUBAGENT_TOOL_NAME, args);
      if (jevScan) {
        return this.confirmWithAudit(
          { toolName: SUBAGENT_TOOL_NAME, label: this.labelForTool(SUBAGENT_TOOL_NAME), args },
          toolCallId,
          "Blocked by the injection guard: the dispatch looks like prompt injection. The user declined this action.",
          `Jev injection guard escalated this auto-approved dispatch (signals: ${(jevScan.signals ?? []).join(",") || "n/a"}, confidence ${jevScan.confidence.toFixed(2)}).`,
        ).then((choice) =>
          choice.approved
            ? undefined
            : { block: true as const, reason: choice.reason ?? "The user declined this action." },
        );
      }
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

  /**
   * Opt-in Jev injection scan. Returns the scan when an otherwise auto-allowed
   * call should escalate to ask, else null. Fail-open: any misconfiguration,
   * missing key, missing egress acknowledgement, timeout, or scan error
   * returns null (no behavior change). Results memoized per tool+args (60s
   * TTL, 200 entries) and capped at 300 scans/session to bound spend.
   */
  private async jevScanArgs(toolName: string, args: unknown): Promise<InjectionScan | null> {
    try {
      const settings = this.getSettings();
      const guard = settings.jev?.injectionGuard;
      if (!guard?.enabled || !guard.allowEgress) return null;
      if (!this.isJevScanWorthyTool(toolName)) return null;
      if (this.jevScans >= JEV_MAX_SCANS_PER_SESSION) return null;
      const key = `${toolName}:${safeJsonPreview(args)}`;
      const cached = this.jevScanCache.get(key);
      if (cached && Date.now() - cached.ts < JEV_SCAN_CACHE_TTL_MS) {
        return cached.flag ? CACHED_ESCALATION : null;
      }
      let apiKey: string | undefined;
      try {
        apiKey = await this.resolveJevApiKey?.();
      } catch {
        apiKey = undefined;
      }
      apiKey = apiKey?.trim() || settings.jev?.apiKey?.trim() || undefined;
      if (!apiKey) return null;
      this.jevScans += 1;
      const scan = await scanToolArgsForInjection(toolName, args, {
        enabled: true,
        apiKey,
        timeoutMs: guard.timeoutMs,
        minConfidence: guard.minConfidence,
        transport: this.jevTransport,
      });
      const flag = shouldEscalateToAsk(scan);
      this.jevScanCache.set(key, { flag, ts: Date.now() });
      if (this.jevScanCache.size > JEV_SCAN_CACHE_MAX) {
        const oldest = this.jevScanCache.keys().next();
        if (!oldest.done) this.jevScanCache.delete(oldest.value);
      }
      return flag ? scan : null;
    } catch {
      return null;
    }
  }

  /** Scan-worthy: mutating tools, MCP tools, subagent dispatch, risky reads. */
  private isJevScanWorthyTool(toolName: string): boolean {
    return (
      MUTATING_TOOLS.has(toolName) ||
      isMcpToolName(toolName) ||
      toolName === SUBAGENT_TOOL_NAME ||
      JEV_SCAN_READ_TOOLS.has(toolName)
    );
  }

  private async confirmWithAudit(
    request: ToolApprovalRequest,
    toolCallId: string,
    deniedReason: string,
    requestedNote?: string,
  ): Promise<UserApprovalChoice> {
    await this.auditApproval({
      decision: "requested",
      toolCallId,
      toolName: request.toolName,
      label: request.label,
      args: request.args,
      reason: requestedNote,
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

/** True when the args request a recursive folder delete (bulk destruction). */
function isRecursiveDeleteArgs(args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    (args as { recursive?: unknown }).recursive === true
  );
}
