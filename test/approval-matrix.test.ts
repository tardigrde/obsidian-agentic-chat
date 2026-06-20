import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AgentService } from "../src/agent/agent-service";
import { type ApprovalPolicy, type ApprovalSettings } from "../src/agent/approval";
import { type AgentMode, resolveModePolicy } from "../src/agent/modes";
import { resolveWorkingDirPolicy } from "../src/agent/working-dir";
import { ObsidianSessionManager } from "../src/session/session-manager";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { MemoryAdapter } from "./helpers/memory-adapter";

/**
 * First-principles tests for the approval/working-dir matrix — the composition
 * resolveModePolicy × resolveWorkingDirPolicy × perTool overrides × MUTATING_TOOLS.
 *
 * The contract (AGENTS.md "Approval gate — non-obvious contract"):
 *   precedence  : plan > slider (yolo) > per-tool override > settings default
 *   composition : the working-dir boundary refines the mode policy **only in Safe
 *                 mode**; YOLO (session-wide allow) and plan (read-only) skip the
 *                 boundary by design. A deny always survives; a granted-dir target
 *                 auto-runs; anything else (even a read, even a pathless call) is
 *                 forced to ask.
 *
 * `composePolicy` below encodes exactly that documented composition; the matrix
 * asserts every interaction cell, and two end-to-end AgentService runs cross-check
 * that `composePolicy` matches the real `gateToolCall` for the subtle cells.
 */

/** Documented gate composition (see file header). Asserted, not assumed. */
function composePolicy(
  mode: AgentMode,
  approval: ApprovalSettings,
  toolName: string,
  args: unknown,
): ApprovalPolicy {
  const base = resolveModePolicy(mode, approval, toolName).policy;
  return mode === "safe" ? resolveWorkingDirPolicy(approval.workingDirs, args, base) : base;
}

type Cell = {
  name: string;
  mode: AgentMode;
  mutating: ApprovalPolicy;
  perTool?: Record<string, ApprovalPolicy>;
  dirs?: string[];
  tool: string;
  args: unknown;
  expected: ApprovalPolicy;
};

const READ = "read";
const WRITE = "write";
const IN_SCOPE = { path: "Notes/a.md" };
const OUT_SCOPE = { path: "Other/a.md" };
const PATHLESS = { pattern: "secret" };

const CELLS: Cell[] = [
  // --- Safe mode: the working-dir boundary is active. ---
  { name: "safe read, no working set → allow", mode: "safe", mutating: "ask", tool: READ, args: IN_SCOPE, expected: "allow" },
  { name: "safe read in-scope → allow", mode: "safe", mutating: "ask", dirs: ["Notes"], tool: READ, args: IN_SCOPE, expected: "allow" },
  { name: "safe read out-of-scope → ask (even reads)", mode: "safe", mutating: "ask", dirs: ["Notes"], tool: READ, args: OUT_SCOPE, expected: "ask" },
  { name: "safe pathless call under a working set → ask", mode: "safe", mutating: "ask", dirs: ["Notes"], tool: "find", args: PATHLESS, expected: "ask" },
  { name: "safe mutating, no working set → mutating policy", mode: "safe", mutating: "ask", tool: WRITE, args: IN_SCOPE, expected: "ask" },
  { name: "safe mutating in-scope → allow", mode: "safe", mutating: "allow", dirs: ["Notes"], tool: WRITE, args: IN_SCOPE, expected: "allow" },
  { name: "safe mutating out-of-scope → ask (boundary beats mutating allow)", mode: "safe", mutating: "allow", dirs: ["Notes"], tool: WRITE, args: OUT_SCOPE, expected: "ask" },
  { name: "safe mutating deny survives in-scope", mode: "safe", mutating: "deny", dirs: ["Notes"], tool: WRITE, args: IN_SCOPE, expected: "deny" },
  { name: "safe perTool allow does NOT bypass out-of-scope boundary", mode: "safe", mutating: "ask", perTool: { write: "allow" }, dirs: ["Notes"], tool: WRITE, args: OUT_SCOPE, expected: "ask" },
  { name: "safe perTool deny survives in-scope", mode: "safe", mutating: "allow", perTool: { write: "deny" }, dirs: ["Notes"], tool: WRITE, args: IN_SCOPE, expected: "deny" },
  { name: "safe perTool allow, no working set → allow", mode: "safe", mutating: "ask", perTool: { write: "allow" }, tool: WRITE, args: OUT_SCOPE, expected: "allow" },

  // --- YOLO mode: session-wide allow; the boundary is skipped entirely. ---
  { name: "yolo mutating denied in settings → allow", mode: "yolo", mutating: "deny", tool: WRITE, args: IN_SCOPE, expected: "allow" },
  { name: "yolo out-of-scope mutating → allow (boundary skipped)", mode: "yolo", mutating: "deny", dirs: ["Notes"], tool: WRITE, args: OUT_SCOPE, expected: "allow" },
  { name: "yolo perTool deny still wins", mode: "yolo", mutating: "allow", perTool: { write: "deny" }, tool: WRITE, args: IN_SCOPE, expected: "deny" },
  { name: "yolo perTool deny wins even under a working set", mode: "yolo", mutating: "allow", perTool: { write: "deny" }, dirs: ["Notes"], tool: WRITE, args: IN_SCOPE, expected: "deny" },
  { name: "yolo out-of-scope read → allow (boundary skipped)", mode: "yolo", mutating: "ask", dirs: ["Notes"], tool: READ, args: OUT_SCOPE, expected: "allow" },

  // --- Plan mode: read-only; the boundary is skipped (plan already denies writes). ---
  { name: "plan mutating → deny", mode: "plan", mutating: "allow", tool: WRITE, args: IN_SCOPE, expected: "deny" },
  { name: "plan mutating in-scope → deny (boundary skipped, plan wins)", mode: "plan", mutating: "allow", dirs: ["Notes"], tool: WRITE, args: IN_SCOPE, expected: "deny" },
  { name: "plan beats a perTool allow", mode: "plan", mutating: "allow", perTool: { write: "allow" }, dirs: ["Notes"], tool: WRITE, args: IN_SCOPE, expected: "deny" },
  { name: "plan out-of-scope read → allow (read-only; boundary skipped)", mode: "plan", mutating: "ask", dirs: ["Notes"], tool: READ, args: OUT_SCOPE, expected: "allow" },
];

describe("approval × working-dir matrix", () => {
  for (const cell of CELLS) {
    it(cell.name, () => {
      const approval: ApprovalSettings = {
        mutating: cell.mutating,
        perTool: cell.perTool ?? {},
        workingDirs: cell.dirs ?? [],
      };
      expect(composePolicy(cell.mode, approval, cell.tool, cell.args)).toBe(cell.expected);
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
  confirmToolCall: () => Promise<boolean> = async () => true,
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
  it("safe + perTool allow on write + out-of-scope target still prompts (boundary beats perTool allow)", async () => {
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "Other/x.md", content: "hi" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "ok" }], stopReason: "stop" },
    ]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "safe",
      approval: { mutating: "ask", perTool: { write: "allow" }, workingDirs: ["Notes"] },
      // confirm() returns false, yet the call was gated to ask because of the boundary.
    }, async () => false);
    await service.sendPrompt("write outside");
    expect(confirmCalls.count).toBe(1);
  });

  it("yolo + working set + out-of-scope mutating call auto-runs (boundary skipped entirely)", async () => {
    const streamFn = scriptedStreamFn([
      { content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "Other/x.md", content: "hi" } }], stopReason: "toolUse" },
      { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    ]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "yolo",
      approval: { mutating: "deny", perTool: {}, workingDirs: ["Notes"] },
    });
    await service.sendPrompt("write outside in yolo");
    // yolo skips the boundary and forces allow, so the user is never prompted.
    expect(confirmCalls.count).toBe(0);
    // The tool ran (against the empty mock vault it errors, but it was not gated).
    const ran = service.getMessages().some((m) => m.role === "toolResult");
    expect(ran).toBe(true);
  });
});

describe("subagent dispatch matrix (gateSubagentDispatch × dispatchCanMutate × mode × working set)", () => {
  // Built-in profiles (always loaded): researcher = read-only, editor = can mutate.
  const dispatch = (agent: string) => ({
    content: [{ type: "toolCall", id: "c1", name: "subagent", arguments: { agent, task: "do it" } } as AssistantMessage["content"][number]],
    stopReason: "toolUse" as const,
  });
  const childReply = (text: string) => ({ content: [{ type: "text" as const, text }], stopReason: "stop" as const });
  const parentFollowup = (text: string) => ({ content: [{ type: "text" as const, text }], stopReason: "stop" as const });

  function toolResult(service: AgentService): { isError: boolean; text: string } | undefined {
    const tr = service.getMessages().find((m) => m.role === "toolResult") as
      | { isError: boolean; content: Array<{ type: string; text?: string }> }
      | undefined;
    if (!tr) return undefined;
    return { isError: tr.isError, text: (tr.content ?? []).map((b) => b.text ?? "").join("") };
  }

  it("safe + no working set: a mutating (editor) dispatch prompts once", async () => {
    const streamFn = scriptedStreamFn([dispatch("editor"), childReply("editor reply"), parentFollowup("all set")]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "safe",
      approval: { mutating: "ask", perTool: {}, workingDirs: [] },
    }, async () => true);
    await service.sendPrompt("edit with a subagent");
    expect(confirmCalls.count).toBe(1);
    expect(toolResult(service)?.isError).toBe(false);
    expect(toolResult(service)?.text).toContain("editor reply");
  });

  it("safe + no working set: a read-only (researcher) fan-out runs with no prompt", async () => {
    const streamFn = scriptedStreamFn([dispatch("researcher"), childReply("found 3 notes"), parentFollowup("done")]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "safe",
      approval: { mutating: "ask", perTool: {}, workingDirs: [] },
    });
    await service.sendPrompt("research with a subagent");
    expect(confirmCalls.count).toBe(0);
    expect(toolResult(service)?.isError).toBe(false);
    expect(toolResult(service)?.text).toContain("found 3 notes");
  });

  it("yolo auto-approves a mutating (editor) dispatch even when settings deny mutating", async () => {
    const streamFn = scriptedStreamFn([dispatch("editor"), childReply("editor reply"), parentFollowup("done")]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "yolo",
      approval: { mutating: "deny", perTool: {}, workingDirs: [] },
    });
    await service.sendPrompt("edit with a subagent in yolo");
    expect(confirmCalls.count).toBe(0);
    expect(toolResult(service)?.isError).toBe(false);
    expect(toolResult(service)?.text).toContain("editor reply");
  });

  it("safe + mutating denied: a mutating (editor) dispatch is blocked before any prompt", async () => {
    const streamFn = scriptedStreamFn([dispatch("editor"), parentFollowup("ok, blocked")]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "safe",
      approval: { mutating: "deny", perTool: {}, workingDirs: [] },
    });
    await service.sendPrompt("edit with a subagent");
    expect(confirmCalls.count).toBe(0);
    expect(toolResult(service)?.isError).toBe(true);
  });

  it("plan: an editor dispatch runs unattended (children are read-only, dispatch is always safe)", async () => {
    const streamFn = scriptedStreamFn([dispatch("editor"), childReply("editor read-only reply"), parentFollowup("done")]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "plan",
      approval: { mutating: "allow", perTool: {}, workingDirs: [] },
    });
    await service.sendPrompt("edit with a subagent in plan");
    expect(confirmCalls.count).toBe(0);
    expect(toolResult(service)?.isError).toBe(false);
  });

  it("safe + working set: even a read-only (researcher) dispatch is confirmed up front", async () => {
    const streamFn = scriptedStreamFn([dispatch("researcher"), parentFollowup("ok, not dispatching")]);
    const { service, confirmCalls } = makeService(streamFn, {
      mode: "safe",
      approval: { mutating: "ask", perTool: {}, workingDirs: ["Notes"] },
    }, async () => false);
    await service.sendPrompt("research with a subagent under a working set");
    expect(confirmCalls.count).toBe(1);
    expect(toolResult(service)?.isError).toBe(true);
  });
});
