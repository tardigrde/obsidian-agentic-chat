import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AgentService } from "../src/agent/agent-service";
import type { ApprovalAuditInput } from "../src/agent/action-audit-log";
import {
  AgentToolCallController,
  type ToolApprovalRequest,
  type UserApprovalChoice,
} from "../src/agent/tool-call-controller";
import { type ApprovalPolicy, type ApprovalSettings } from "../src/agent/approval";
import { type AgentMode, resolveModePolicy } from "../src/agent/modes";
import type { AgentRole } from "../src/agent/subagents";
import { createMcpServerSettings } from "../src/mcp/settings";
import { ObsidianSessionManager, SessionWriteRegistry } from "../src/session/session-manager";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings-schema";
import { SubagentRegistry } from "../src/tools/subagent-tool";
import { MemoryAdapter } from "./helpers/memory-adapter";

/**
 * First-principles tests for the approval matrix: the composition
 * resolveModePolicy × perTool overrides × MUTATING_TOOLS.
 *
 * The contract (AGENTS.md "Approval gate — non-obvious contract"):
 *   precedence  : slider (yolo) > per-tool override > settings default
 *   composition : Safe honors the policy; YOLO forces the mutating default to
 *                 allow. A per-tool deny always survives, and a per-tool ask
 *                 still overrides YOLO's blanket allow.
 *
 * `composePolicy` below encodes that documented composition; the matrix asserts
 * every interaction cell, and two end-to-end AgentService runs cross-check that
 * `composePolicy` matches the real `gateToolCall`.
 */

/** Documented gate composition (see file header). Asserted, not assumed. */
function composePolicy(
  mode: AgentMode,
  approval: ApprovalSettings,
  toolName: string,
): ApprovalPolicy {
  return resolveModePolicy(mode, approval, toolName).policy;
}

type Cell = {
  name: string;
  mode: AgentMode;
  mutating: ApprovalPolicy;
  perTool?: Record<string, ApprovalPolicy>;
  tool: string;
  expected: ApprovalPolicy;
};

const READ = "read";
const WRITE = "write";

const CELLS: Cell[] = [
  // --- Safe mode: the configured policy decides. ---
  { name: "safe read, mutating ask → allow", mode: "safe", mutating: "ask", tool: READ, expected: "allow" },
  { name: "safe read, per-tool deny → deny", mode: "safe", mutating: "ask", perTool: { read: "deny" }, tool: READ, expected: "deny" },
  { name: "safe mutating, ask → ask", mode: "safe", mutating: "ask", tool: WRITE, expected: "ask" },
  { name: "safe mutating, allow → allow", mode: "safe", mutating: "allow", tool: WRITE, expected: "allow" },
  { name: "safe mutating, deny → deny", mode: "safe", mutating: "deny", tool: WRITE, expected: "deny" },
  { name: "safe per-tool allow beats mutating ask", mode: "safe", mutating: "ask", perTool: { write: "allow" }, tool: WRITE, expected: "allow" },
  { name: "safe per-tool deny beats mutating allow", mode: "safe", mutating: "allow", perTool: { write: "deny" }, tool: WRITE, expected: "deny" },
  { name: "safe per-tool ask beats mutating allow", mode: "safe", mutating: "allow", perTool: { write: "ask" }, tool: WRITE, expected: "ask" },

  // --- YOLO mode: session-wide allow for the mutating default. ---
  { name: "yolo mutating deny → allow", mode: "yolo", mutating: "deny", tool: WRITE, expected: "allow" },
  { name: "yolo mutating ask → allow", mode: "yolo", mutating: "ask", tool: WRITE, expected: "allow" },
  { name: "yolo per-tool deny still wins", mode: "yolo", mutating: "allow", perTool: { write: "deny" }, tool: WRITE, expected: "deny" },
  { name: "yolo per-tool ask still wins", mode: "yolo", mutating: "allow", perTool: { write: "ask" }, tool: WRITE, expected: "ask" },
  { name: "yolo read stays allow", mode: "yolo", mutating: "deny", tool: READ, expected: "allow" },
];

describe("approval matrix", () => {
  for (const cell of CELLS) {
    it(cell.name, () => {
      const approval: ApprovalSettings = {
        mutating: cell.mutating,
        perTool: cell.perTool ?? {},
      };
      expect(composePolicy(cell.mode, approval, cell.tool)).toBe(cell.expected);
    });
  }
});

/** Scripts one assistant message per agent turn. */
function scriptedStreamFn(
  turns: Array<{ content: AssistantMessage["content"]; stopReason: "stop" | "toolUse" }>,
): StreamFn {
  let turn = 0;
  return ((model: Model<"openai-completions">) => {
    const stream = createAssistantMessageEventStream();
    const spec = turns[Math.min(turn, turns.length - 1)];
    turn += 1;
    const message = {
      role: "assistant" as const,
      content: spec.content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: spec.stopReason,
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: spec.stopReason, message });
      stream.end(message);
    });
    return stream;
  }) as unknown as StreamFn;
}

function makeService(
  streamFn: StreamFn,
  settings: Partial<AgenticChatSettings>,
  confirmToolCall: () => Promise<UserApprovalChoice> = async () => ({ approved: true, remember: false }),
): { service: AgentService; confirmCalls: { count: number } } {
  const merged: AgenticChatSettings = {
    ...DEFAULT_SETTINGS,
    openrouterApiKey: "test-key",
    ...settings,
    approval: { ...DEFAULT_SETTINGS.approval, ...(settings.approval ?? {}) },
  };
  const confirmCalls = { count: 0 };
  const adapter = new MemoryAdapter();
  const sessionManager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test", new SessionWriteRegistry());
  const service = new AgentService({
    app: { vault: { on: () => ({}), offref: () => {} }, workspace: {} } as unknown as App,
    getSettings: () => merged,
    sessionManager,
    streamFn,
    confirmToolCall: async () => {
      confirmCalls.count += 1;
      return confirmToolCall();
    },
  });
  return { service, confirmCalls };
}

describe("approval matrix: end-to-end cross-checks through gateToolCall", () => {
  it("safe + per-tool allow on write auto-runs without a prompt", async () => {
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "Notes/x.md", content: "hi" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "safe",
      approval: { mutating: "ask", perTool: { write: "allow" } },
    }, async () => ({ approved: false, remember: false }));
    await service.sendPrompt("write with a standing allow");
    // A per-tool allow is standing consent, so the confirm hook is never called.
    expect(confirmCalls.count).toBe(0);
  });

  it("yolo + mutating deny auto-runs without a prompt", async () => {
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "Other/x.md", content: "hi" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "yolo",
      approval: { mutating: "deny", perTool: {} },
    });
    await service.sendPrompt("write in yolo");
    // yolo forces allow, so the user is never prompted.
    expect(confirmCalls.count).toBe(0);
    // The tool ran (against the empty mock vault it errors, but it was not gated).
    const ran = service.getMessages().some((m) => m.role === "toolResult");
    expect(ran).toBe(true);
  });
});

describe("subagent dispatch matrix (gateSubagentDispatch × dispatchCanMutate × mode)", () => {
  // Single built-in Explorer role (read-only recon).
  const dispatch = (agent: string) => ({
    content: [{ type: "toolCall", id: "c1", name: "subagent", arguments: { agent, task: "do it" } } as AssistantMessage["content"][number]],
    stopReason: "toolUse" as const,
  });
  const childReply = (text: string) => ({ content: [{ type: "text" as const, text }], stopReason: "stop" as const });
  const parentFollowup = (text: string) => ({ content: [{ type: "text" as const, text }], stopReason: "stop" as const });

  function toolResult(service: AgentService): { isError: boolean; text: string } | undefined {
    const tr = service.getMessages().find((m) => m.role === "toolResult") as
      | { isError: boolean; content: unknown }
      | undefined;
    if (!tr) return undefined;
    // Content may be a string or a block array; handle both so a string-content
    // result doesn't throw on `.map`.
    const content = tr.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((b) => (typeof b === "object" && b !== null ? (b as { text?: string }).text ?? "" : ""))
            .join("")
        : "";
    return { isError: tr.isError, text };
  }

  it("safe: a read-only explorer dispatch does not prompt (S8: explorer read-only, inherits parent)", async () => {
    const streamFn = scriptedStreamFn([dispatch("explorer"), childReply("explorer reply"), parentFollowup("all set")]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "safe",
      approval: { mutating: "ask", perTool: {} },
    }, async () => ({ approved: true, remember: false }));
    await service.sendPrompt("edit with a subagent");
    expect(confirmCalls.count).toBe(0);
    expect(toolResult(service)?.isError).toBe(false);
    expect(toolResult(service)?.text).toContain("explorer reply");
  });

  it("safe: a read-only fan-out runs with no prompt", async () => {
    const streamFn = scriptedStreamFn([dispatch("explorer"), childReply("found 3 notes"), parentFollowup("done")]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "safe",
      approval: { mutating: "ask", perTool: {} },
    });
    await service.sendPrompt("research with a subagent");
    expect(confirmCalls.count).toBe(0);
    expect(toolResult(service)?.isError).toBe(false);
    expect(toolResult(service)?.text).toContain("found 3 notes");
  });

  it("yolo auto-approves a read-only explorer dispatch (S8: explorer has no mutating tools, gate is vacuous by design)", async () => {
    const streamFn = scriptedStreamFn([dispatch("explorer"), childReply("explorer reply"), parentFollowup("done")]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "yolo",
      approval: { mutating: "deny", perTool: {} },
    });
    await service.sendPrompt("edit with a subagent in yolo");
    expect(confirmCalls.count).toBe(0);
    expect(toolResult(service)?.isError).toBe(false);
    expect(toolResult(service)?.text).toContain("explorer reply");
  });

  it("safe + mutating denied: a read-only dispatch is not blocked (S8: explorer has no mutating tools)", async () => {
    const streamFn = scriptedStreamFn([dispatch("explorer"), childReply("explorer reply"), parentFollowup("all set")]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "safe",
      approval: { mutating: "deny", perTool: {} },
    });
    await service.sendPrompt("edit with a subagent");
    expect(confirmCalls.count).toBe(0);
    expect(toolResult(service)?.isError).toBe(false);
    expect(toolResult(service)?.text).toContain("explorer reply");
  });
});

type GateCell = {
  name: string;
  mode: AgentMode;
  approval: ApprovalSettings;
  tool: string;
  args?: unknown;
  mcpServerApproval?: ApprovalPolicy;
  mcpStateApproval?: ApprovalPolicy;
  profiles?: AgentRole[];
  expectedDecision: ApprovalAuditInput["decision"];
  expectedConfirmed: boolean;
  expectedBlocked: boolean;
  expectedReason?: string;
};

const EXPLORER: AgentRole = {
  name: "explorer",
  description: "Read-only explorer",
  systemPrompt: "",
  toolAllowlist: ["read", "search"],
};

const WRITER: AgentRole = {
  name: "writer",
  description: "Writes notes",
  systemPrompt: "",
  toolAllowlist: ["write"],
};

const GATE_CELLS: GateCell[] = [
  // Vault tools.
  { name: "safe read allows", mode: "safe", approval: { mutating: "ask", perTool: {} }, tool: "read", expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "safe mutating ask confirms", mode: "safe", approval: { mutating: "ask", perTool: {} }, tool: "write", expectedDecision: "approved", expectedConfirmed: true, expectedBlocked: false },
  { name: "safe mutating deny blocks", mode: "safe", approval: { mutating: "deny", perTool: {} }, tool: "write", expectedDecision: "denied", expectedConfirmed: false, expectedBlocked: true, expectedReason: "The \"write\" tool is disabled by your approval settings." },
  { name: "safe per-tool allow wins", mode: "safe", approval: { mutating: "ask", perTool: { write: "allow" } }, tool: "write", expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "safe per-tool deny wins", mode: "safe", approval: { mutating: "allow", perTool: { write: "deny" } }, tool: "write", expectedDecision: "denied", expectedConfirmed: false, expectedBlocked: true },
  { name: "safe per-tool ask confirms", mode: "safe", approval: { mutating: "allow", perTool: { write: "ask" } }, tool: "write", expectedDecision: "approved", expectedConfirmed: true, expectedBlocked: false },
  { name: "yolo forces mutating allow", mode: "yolo", approval: { mutating: "deny", perTool: {} }, tool: "write", expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "yolo keeps per-tool deny", mode: "yolo", approval: { mutating: "allow", perTool: { write: "deny" } }, tool: "write", expectedDecision: "denied", expectedConfirmed: false, expectedBlocked: true },
  { name: "yolo keeps per-tool ask", mode: "yolo", approval: { mutating: "allow", perTool: { write: "ask" } }, tool: "write", expectedDecision: "approved", expectedConfirmed: true, expectedBlocked: false },

  // Persistent skill tools default to ask.
  { name: "load_skill ignores mutating allow", mode: "safe", approval: { mutating: "allow", perTool: {} }, tool: "load_skill", expectedDecision: "approved", expectedConfirmed: true, expectedBlocked: false },
  { name: "load_skill honors per-tool allow", mode: "safe", approval: { mutating: "ask", perTool: { load_skill: "allow" } }, tool: "load_skill", expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "create_skill honors per-tool deny", mode: "safe", approval: { mutating: "allow", perTool: { create_skill: "deny" } }, tool: "create_skill", expectedDecision: "denied", expectedConfirmed: false, expectedBlocked: true },
  { name: "yolo still asks skill tools", mode: "yolo", approval: { mutating: "deny", perTool: {} }, tool: "unload_skill", expectedDecision: "approved", expectedConfirmed: true, expectedBlocked: false },

  // Recursive folder delete always asks unless the user gave a standing allow.
  { name: "recursive delete asks even when mutating allows", mode: "safe", approval: { mutating: "allow", perTool: {} }, tool: "delete", args: { path: "Folder", recursive: true }, expectedDecision: "approved", expectedConfirmed: true, expectedBlocked: false },
  { name: "recursive delete honors per-tool allow", mode: "safe", approval: { mutating: "ask", perTool: { delete: "allow" } }, tool: "delete", args: { path: "Folder", recursive: true }, expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "yolo recursive delete still asks", mode: "yolo", approval: { mutating: "allow", perTool: {} }, tool: "delete", args: { path: "Folder", recursive: true }, expectedDecision: "approved", expectedConfirmed: true, expectedBlocked: false },
  { name: "recursive delete per-tool deny blocks", mode: "safe", approval: { mutating: "allow", perTool: { delete: "deny" } }, tool: "delete", args: { path: "Folder", recursive: true }, expectedDecision: "denied", expectedConfirmed: false, expectedBlocked: true },
  { name: "non-recursive delete follows mutating allow", mode: "safe", approval: { mutating: "allow", perTool: {} }, tool: "delete", args: { path: "Notes/A.md" }, expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },

  // MCP tools: per-tool > server (ask default) > YOLO rewrite.
  { name: "mcp server ask confirms", mode: "safe", approval: { mutating: "allow", perTool: {} }, tool: "mcp__docs__search", mcpServerApproval: "ask", expectedDecision: "approved", expectedConfirmed: true, expectedBlocked: false },
  { name: "mcp server allow auto-approves", mode: "safe", approval: { mutating: "ask", perTool: {} }, tool: "mcp__docs__search", mcpServerApproval: "allow", expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "mcp server deny blocks", mode: "safe", approval: { mutating: "allow", perTool: {} }, tool: "mcp__docs__search", mcpServerApproval: "deny", expectedDecision: "denied", expectedConfirmed: false, expectedBlocked: true, expectedReason: "The \"mcp__docs__search\" MCP tool is disabled by your MCP approval settings." },
  { name: "mcp per-tool allow beats server ask", mode: "safe", approval: { mutating: "ask", perTool: { "mcp__docs__search": "allow" } }, tool: "mcp__docs__search", mcpServerApproval: "ask", expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "mcp per-tool deny beats server allow", mode: "safe", approval: { mutating: "ask", perTool: { "mcp__docs__search": "deny" } }, tool: "mcp__docs__search", mcpServerApproval: "allow", expectedDecision: "denied", expectedConfirmed: false, expectedBlocked: true },
  { name: "mcp per-tool ask beats server allow", mode: "safe", approval: { mutating: "ask", perTool: { "mcp__docs__search": "ask" } }, tool: "mcp__docs__search", mcpServerApproval: "allow", expectedDecision: "approved", expectedConfirmed: true, expectedBlocked: false },
  { name: "yolo rewrites mcp server ask to allow", mode: "yolo", approval: { mutating: "deny", perTool: {} }, tool: "mcp__docs__search", mcpServerApproval: "ask", expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "yolo keeps mcp server deny", mode: "yolo", approval: { mutating: "allow", perTool: {} }, tool: "mcp__docs__search", mcpServerApproval: "deny", expectedDecision: "denied", expectedConfirmed: false, expectedBlocked: true },
  { name: "yolo keeps mcp per-tool deny", mode: "yolo", approval: { mutating: "allow", perTool: { "mcp__docs__search": "deny" } }, tool: "mcp__docs__search", mcpServerApproval: "ask", expectedDecision: "denied", expectedConfirmed: false, expectedBlocked: true },
  { name: "yolo keeps mcp per-tool ask", mode: "yolo", approval: { mutating: "allow", perTool: { "mcp__docs__search": "ask" } }, tool: "mcp__docs__search", mcpServerApproval: "allow", expectedDecision: "approved", expectedConfirmed: true, expectedBlocked: false },
  { name: "mcp plugin state overrides server settings", mode: "safe", approval: { mutating: "ask", perTool: {} }, tool: "mcp__docs__search", mcpServerApproval: "ask", mcpStateApproval: "allow", expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "mcp without a configured server defaults to ask", mode: "safe", approval: { mutating: "allow", perTool: {} }, tool: "mcp__missing__search", expectedDecision: "approved", expectedConfirmed: true, expectedBlocked: false },

  // Subagent dispatch: only mutating child allowlists matter; ask auto-approves today.
  { name: "subagent explorer dispatch auto-approves", mode: "safe", approval: { mutating: "deny", perTool: {} }, tool: "subagent", args: { agent: "explorer", task: "look" }, profiles: [EXPLORER], expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "subagent mutating allow auto-approves", mode: "safe", approval: { mutating: "allow", perTool: {} }, tool: "subagent", args: { agent: "writer", task: "write" }, profiles: [WRITER], expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "subagent mutating ask auto-approves today", mode: "safe", approval: { mutating: "ask", perTool: {} }, tool: "subagent", args: { agent: "writer", task: "write" }, profiles: [WRITER], expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "subagent mutating deny blocks", mode: "safe", approval: { mutating: "deny", perTool: {} }, tool: "subagent", args: { agent: "writer", task: "write" }, profiles: [WRITER], expectedDecision: "denied", expectedConfirmed: false, expectedBlocked: true, expectedReason: "Subagent dispatch is blocked because mutating tools are denied." },
  { name: "yolo subagent mutating deny auto-approves", mode: "yolo", approval: { mutating: "deny", perTool: {} }, tool: "subagent", args: { agent: "writer", task: "write" }, profiles: [WRITER], expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "subagent per-tool deny makes the dispatch read-only", mode: "safe", approval: { mutating: "deny", perTool: { write: "deny" } }, tool: "subagent", args: { agent: "writer", task: "write" }, profiles: [WRITER], expectedDecision: "auto-approved", expectedConfirmed: false, expectedBlocked: false },
  { name: "subagent unknown agent fails closed", mode: "safe", approval: { mutating: "ask", perTool: {} }, tool: "subagent", args: { agent: "missing", task: "write" }, profiles: [WRITER], expectedDecision: "denied", expectedConfirmed: false, expectedBlocked: true, expectedReason: "subagent: unknown agent \"missing\". Available: writer." },
];

describe("tool-call controller policy table", () => {
  for (const cell of GATE_CELLS) {
    it(cell.name, async () => {
      const requests: ToolApprovalRequest[] = [];
      const approvals: ApprovalAuditInput[] = [];
      const settings: AgenticChatSettings = {
        ...DEFAULT_SETTINGS,
        provider: "openrouter",
        openrouterApiKey: "test-key",
        mode: cell.mode,
        approval: cell.approval,
        mcp: {
          ...DEFAULT_SETTINGS.mcp,
          servers: cell.mcpServerApproval
            ? [createMcpServerSettings({ id: "docs", name: "Docs", url: "https://docs.example/mcp", approval: cell.mcpServerApproval })]
            : [],
        },
        plugins: {
          ...DEFAULT_SETTINGS.plugins,
          mcpState: cell.mcpStateApproval
            ? {
                docs: {
                  ...createMcpServerSettings({ id: "docs", approval: cell.mcpStateApproval }),
                  approval: cell.mcpStateApproval,
                },
              }
            : {},
        },
      };
      const controller = new AgentToolCallController({
        app: {} as App,
        getSettings: () => settings,
        confirmToolCall: async (request) => {
          requests.push(request);
          return { approved: true, remember: false };
        },
        getTools: () => [{ name: cell.tool, label: cell.tool } as never],
        getProfiles: () => cell.profiles ?? [],
        onUndoApplied: () => {},
        recordApproval: (input) => {
          approvals.push(input);
        },
        subagentRegistry: new SubagentRegistry(),
      });

      const decision = await controller.beforeToolCall({
        toolCall: { id: `call-${cell.name}`, name: cell.tool },
        args: cell.args ?? {},
      });

      const decisions = approvals.map((approval) => approval.decision);
      expect(decisions.at(-1)).toBe(cell.expectedDecision);
      expect(requests).toHaveLength(cell.expectedConfirmed ? 1 : 0);
      expect(Boolean(decision?.block)).toBe(cell.expectedBlocked);
      if (cell.expectedReason) expect(decision?.reason).toBe(cell.expectedReason);
    });
  }
});
