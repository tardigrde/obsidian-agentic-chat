import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AgentService } from "../src/agent/agent-service";
import type { UserApprovalChoice } from "../src/agent/tool-call-controller";
import { type ApprovalPolicy, type ApprovalSettings } from "../src/agent/approval";
import { type AgentMode, resolveModePolicy } from "../src/agent/modes";
import { ObsidianSessionManager } from "../src/session/session-manager";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings-schema";
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
  const sessionManager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
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
