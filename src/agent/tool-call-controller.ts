import type { App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgenticChatSettings } from "../settings";
import type { ApprovalPolicy } from "./approval";
import { isMcpToolName, mcpServerIdFromToolName } from "../mcp/tools";
import { MUTATING_TOOLS } from "../tools/tool-contracts";
import { SUBAGENT_TOOL_NAME, normalizeTasks } from "../tools/subagent-tool";
import type { AgentProfile } from "./subagents";
import { resolveModePolicy } from "./modes";
import { resolveWorkingDirPolicy } from "./working-dir";
import { UNDOABLE_TOOLS, type UndoEntry, applyUndo, captureUndo } from "./undo";

/** A pending tool call the user must approve. */
export interface ToolApprovalRequest {
  toolName: string;
  label: string;
  args: unknown;
}

export type ToolGateDecision = { block: true; reason: string } | undefined;

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
  };
  isError: boolean;
}

interface ToolCallControllerOptions {
  app: App;
  getSettings: () => AgenticChatSettings;
  confirmToolCall: (request: ToolApprovalRequest) => Promise<boolean>;
  getTools: () => AgentTool[];
  getProfiles: () => AgentProfile[];
  onUndoApplied: () => void;
}

/**
 * Owns per-session tool-call policy state: approval gates, pending undo captures,
 * and the undo stack exposed by `/undo`.
 */
export class AgentToolCallController {
  private readonly app: App;
  private readonly getSettings: () => AgenticChatSettings;
  private readonly confirmToolCall: (request: ToolApprovalRequest) => Promise<boolean>;
  private readonly getTools: () => AgentTool[];
  private readonly getProfiles: () => AgentProfile[];
  private readonly onUndoApplied: () => void;

  /** Reversible records of mutating tool calls, newest last (for undo-last-change). */
  private undoStack: UndoEntry[] = [];
  /** Undo records captured pre-execution, keyed by tool call id, pending success. */
  private pendingUndo = new Map<string, UndoEntry>();

  constructor(options: ToolCallControllerOptions) {
    this.app = options.app;
    this.getSettings = options.getSettings;
    this.confirmToolCall = options.confirmToolCall;
    this.getTools = options.getTools;
    this.getProfiles = options.getProfiles;
    this.onUndoApplied = options.onUndoApplied;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * Revert the most recent mutating tool call (write/edit/rename/delete) this
   * session. Undo state is in-memory, so it doesn't survive a reload or rewind.
   */
  async undoLastChange(): Promise<string> {
    const entry = this.undoStack.pop();
    if (!entry) return "Nothing to undo.";
    try {
      const summary = await applyUndo(this.app, entry);
      this.onUndoApplied();
      return summary;
    } catch (error) {
      // Restore the entry so the user can retry or inspect; report the failure.
      this.undoStack.push(entry);
      return `Could not undo: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  clearSessionState(): void {
    this.undoStack = [];
    this.pendingUndo.clear();
  }

  async beforeToolCall(context: BeforeToolCallContext): Promise<ToolGateDecision> {
    const decision = await this.gateToolCall(context.toolCall.name, context.args);
    // Capture the inverse only for allowed mutating calls; a blocked call never
    // runs, so it has nothing to undo.
    if (!decision && UNDOABLE_TOOLS.has(context.toolCall.name)) {
      const entry = await captureUndo(this.app, context.toolCall.name, context.args);
      if (entry) this.pendingUndo.set(context.toolCall.id, entry);
    }
    return decision;
  }

  async afterToolCall(context: AfterToolCallContext): Promise<undefined> {
    const entry = this.pendingUndo.get(context.toolCall.id);
    if (entry) {
      this.pendingUndo.delete(context.toolCall.id);
      // Only record successful mutations; a failed tool left nothing to undo.
      if (!context.isError) this.undoStack.push(entry);
    }
    return undefined;
  }

  private async gateToolCall(toolName: string, args: unknown): Promise<ToolGateDecision> {
    const settings = this.getSettings();
    if (toolName === SUBAGENT_TOOL_NAME) return this.gateSubagentDispatch(settings, args);
    if (isMcpToolName(toolName)) return this.gateMcpToolCall(settings, toolName, args);
    const decision = resolveModePolicy(settings.mode, settings.approval, toolName);
    const { reason } = decision;
    // Working-dir boundary keys off path/newPath args, so only Safe mode (which can scope
    // calls to granted dirs) needs it; YOLO is a session-wide allow and plan is read-only.
    const scoped = settings.mode === "safe";
    // Working-dir boundary (C1/S2): in Safe mode, granted dirs auto-run inside and route
    // out-of-scope targets through ask. YOLO is a deliberate session-wide allow, and plan
    // already forces read-only, so the boundary only refines Safe.
    const policy = scoped
      ? resolveWorkingDirPolicy(settings.approval.workingDirs, args, decision.policy)
      : decision.policy;
    if (policy === "allow") return undefined;
    if (policy === "deny") {
      return { block: true, reason: reason ?? `The "${toolName}" tool is disabled by your approval settings.` };
    }
    const tool = this.getTools().find((candidate) => candidate.name === toolName);
    const approved = await this.confirmToolCall({ toolName, label: tool?.label ?? toolName, args });
    return approved ? undefined : { block: true, reason: "The user declined this action." };
  }

  private async gateMcpToolCall(
    settings: AgenticChatSettings,
    toolName: string,
    args: unknown,
  ): Promise<ToolGateDecision> {
    const policy = this.resolveMcpPolicy(settings, toolName);
    if (policy === "allow") return undefined;
    if (policy === "deny") {
      return { block: true, reason: `The "${toolName}" MCP tool is disabled by your MCP approval settings.` };
    }
    const tool = this.getTools().find((candidate) => candidate.name === toolName);
    const approved = await this.confirmToolCall({
      toolName,
      label: tool?.label ?? toolName,
      args,
    });
    return approved ? undefined : { block: true, reason: "The user declined this MCP tool call." };
  }

  private resolveMcpPolicy(settings: AgenticChatSettings, toolName: string): ApprovalPolicy {
    const override = settings.approval.perTool[toolName];
    if (override) return override;
    const serverId = mcpServerIdFromToolName(toolName);
    const server = settings.mcp.servers.find((candidate) => candidate.id === serverId);
    return server?.approval ?? "ask";
  }

  /**
   * Gate a subagent dispatch. In **plan** mode children are forced read-only, so a
   * dispatch is always safe. In **YOLO** the session master switch auto-approves it.
   * Otherwise (safe) it is gated like a mutating action — but only when some dispatched
   * profile can actually write, so a pure research fan-out never prompts.
   *
   * Working-dir caveat: children run without a per-call gate, so `resolveWorkingDirPolicy`
   * never sees their tool calls. When a working set is configured we therefore confirm the
   * dispatch up front (even a read-only fan-out) rather than let it read/write outside the
   * granted dirs unattended — full per-child path enforcement is tracked as future work.
   */
  private async gateSubagentDispatch(settings: AgenticChatSettings, args: unknown): Promise<ToolGateDecision> {
    if (settings.mode === "plan") return undefined;
    if (settings.mode === "safe" && settings.approval.workingDirs.length > 0) {
      if (this.dispatchCanMutate(args) && settings.approval.mutating === "deny") {
        return { block: true, reason: "Subagent dispatch is blocked because mutating tools are denied." };
      }
      const label = "Dispatch subagents (children are not limited to your working directories)";
      const approved = await this.confirmToolCall({ toolName: SUBAGENT_TOOL_NAME, label, args });
      return approved ? undefined : { block: true, reason: "The user declined to dispatch subagents." };
    }
    if (!this.dispatchCanMutate(args)) return undefined;
    const policy = settings.mode === "yolo" ? "allow" : settings.approval.mutating;
    if (policy === "allow") return undefined;
    if (policy === "deny") {
      return { block: true, reason: "Subagent dispatch is blocked because mutating tools are denied." };
    }
    // This dispatch can mutate the vault and child writes then run unattended, so
    // make the one-time approval say so explicitly.
    const label = "Dispatch subagents (auto-approves their file changes)";
    const approved = await this.confirmToolCall({ toolName: SUBAGENT_TOOL_NAME, label, args });
    return approved ? undefined : { block: true, reason: "The user declined to dispatch subagents." };
  }

  /** True when any dispatched profile's allowlist includes a mutating tool. */
  private dispatchCanMutate(args: unknown): boolean {
    const tasks = normalizeTasks((args ?? {}) as Parameters<typeof normalizeTasks>[0]);
    return tasks.some((task) => {
      const profile = this.getProfiles().find((candidate) => candidate.name === task.agent);
      return !!profile && profile.toolAllowlist.some((name) => MUTATING_TOOLS.has(name));
    });
  }
}
