import { describe, expect, it, vi } from "vitest";
import {
  assessToolRisk,
  buildRiskState,
  isAutoModeGatedTool,
} from "../src/agent/jev-automode";
import type { JevTransport } from "../src/agent/jev-client";
import { AgentToolCallController } from "../src/agent/tool-call-controller";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings";
import type { AgenticChatSettings } from "../src/settings";

function jsonTransport(body: unknown): JevTransport {
  return async () => ({ status: 200, text: JSON.stringify(body) });
}

const KEY = "test-key";
const ON = { enabled: true, apiKey: KEY, allowEgress: true } as const;
const RISKY = jsonTransport({ answers: { risky: { type: "noul", noul: 0.95 } } });
const SAFE = jsonTransport({ answers: { risky: { type: "noul", noul: 0.05 } } });

describe("isAutoModeGatedTool", () => {
  it("gates defaults + mcp__* + extras, never plain reads", () => {
    expect(isAutoModeGatedTool("delete")).toBe(true);
    expect(isAutoModeGatedTool("mcp__server__tool")).toBe(true);
    expect(isAutoModeGatedTool("read")).toBe(false);
    expect(isAutoModeGatedTool("write")).toBe(false);
    expect(isAutoModeGatedTool("write", ["write"])).toBe(true);
  });
});

describe("buildRiskState", () => {
  it("redacts secrets, truncates", () => {
    const s = buildRiskState("delete", { path: "a.md", recursive: true, token: "sk-abcdefgh12345678" });
    expect(s).toContain("tool:delete");
    expect(s).not.toContain("sk-abcdefgh12345678");
  });
});

describe("assessToolRisk", () => {
  it("fail-open when disabled/keyless/egress-unacked/unlisted", async () => {
    const t = vi.fn(RISKY);
    for (const cfg of [
      { ...ON, enabled: false },
      { ...ON, apiKey: "" },
      { ...ON, allowEgress: false },
    ]) {
      expect((await assessToolRisk("delete", {}, { ...cfg, transport: t })).risky).toBe(false);
    }
    expect((await assessToolRisk("read", {}, { ...ON, transport: t })).risky).toBe(false);
    expect(t).not.toHaveBeenCalled();
  });
  it("risky on confident verdict, safe below threshold or on error", async () => {
    expect((await assessToolRisk("delete", {}, { ...ON, transport: RISKY })).risky).toBe(true);
    expect((await assessToolRisk("delete", {}, { ...ON, transport: SAFE })).risky).toBe(false);
    const low = jsonTransport({ answers: { risky: { type: "noul", noul: 0.6 } } });
    expect((await assessToolRisk("delete", {}, { ...ON, transport: low })).risky).toBe(false);
    const err = (async () => { throw new Error("net"); }) as unknown as JevTransport;
    expect((await assessToolRisk("delete", {}, { ...ON, transport: err })).risky).toBe(false);
    const bad = jsonTransport({ answers: { risky: { type: "noul", noul: 2 } } });
    expect((await assessToolRisk("delete", {}, { ...ON, transport: bad })).risky).toBe(false);
  });
});

describe("jev settings healing", () => {
  it("defaults to disabled block mode", () => {
    const s = mergeSettings({});
    expect(s.jev.autoMode).toMatchObject({ enabled: false, allowEgress: false, mode: "block", tools: [] });
  });
  it("heals hostile values", () => {
    const s = mergeSettings({
      jev: {
        autoMode: { enabled: 1, allowEgress: "yes", mode: "nuke", tools: ["ok", 42, "x".repeat(200)], timeoutMs: -1, minConfidence: 5 },
      },
    } as unknown as Partial<AgenticChatSettings>);
    expect(s.jev.autoMode.enabled).toBe(false);
    expect(s.jev.autoMode.allowEgress).toBe(false);
    expect(s.jev.autoMode.mode).toBe("block");
    expect(s.jev.autoMode.tools).toEqual(["ok"]);
    expect(s.jev.autoMode.timeoutMs).toBeGreaterThanOrEqual(50);
    expect(s.jev.autoMode.minConfidence).toBeLessThanOrEqual(1);
  });
});

describe("tool-call-controller automode wiring", () => {
  function settingsWith(mode: "block" | "escalate"): AgenticChatSettings {
    return {
      ...DEFAULT_SETTINGS,
      mode: "yolo",
      jev: {
        ...DEFAULT_SETTINGS.jev,
        apiKey: KEY,
        autoMode: { enabled: true, allowEgress: true, mode, tools: [], timeoutMs: 300, minConfidence: 0.8 },
      },
    };
  }
  function controller(
    settings: AgenticChatSettings,
    transport: JevTransport,
    confirm: () => Promise<{ approved: boolean; remember: boolean }>,
    audited: unknown[],
  ) {
    return new AgentToolCallController({
      app: {} as never,
      getSettings: () => settings,
      confirmToolCall: confirm as never,
      getTools: () => [{ name: "delete", label: "Delete" }, { name: "read", label: "Read" }] as never,
      getProfiles: () => [],
      onUndoApplied: () => {},
      recordApproval: (input) => {
        audited.push(input);
      },
      jevTransport: transport,
    });
  }

  it("blocks confidently-risky gated calls with audit", async () => {
    const audited: unknown[] = [];
    const confirm = vi.fn(async () => ({ approved: true, remember: false }));
    const c = controller(settingsWith("block"), RISKY, confirm, audited);
    const decision = await c.beforeToolCall({
      toolCall: { id: "t1", name: "delete" },
      args: { path: "Notes/old.md" },
    });
    expect(decision).toMatchObject({ block: true });
    expect((decision as { reason: string }).reason).toMatch(/AutoMode/);
    expect(confirm).not.toHaveBeenCalled();
    expect(audited.some((a) => (a as { decision: string }).decision === "denied")).toBe(true);
  });

  it("escalates to ask in escalate mode", async () => {
    const audited: unknown[] = [];
    const confirm = vi.fn(async () => ({ approved: false, remember: false }));
    const c = controller(settingsWith("escalate"), RISKY, confirm, audited);
    const decision = await c.beforeToolCall({
      toolCall: { id: "t1", name: "delete" },
      args: { path: "Notes/old.md" },
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({ block: true });
  });

  it("allows safe/unlisted/disabled without transport", async () => {
    const audited: unknown[] = [];
    const confirm = vi.fn(async () => ({ approved: true, remember: false }));
    // Safe verdict on gated tool.
    const c1 = controller(settingsWith("block"), SAFE, confirm, audited);
    expect(await c1.beforeToolCall({ toolCall: { id: "t1", name: "delete" }, args: {} })).toBeUndefined();
    // Unlisted tool never scanned.
    const t2 = vi.fn(RISKY);
    const c2 = controller(settingsWith("block"), t2, confirm, audited);
    expect(await c2.beforeToolCall({ toolCall: { id: "t2", name: "read" }, args: { path: "a.md" } })).toBeUndefined();
    expect(t2).not.toHaveBeenCalled();
    // write/edit deliberately unscanned by default (undo + Safe-mode ask cover them).
    const t2b = vi.fn(RISKY);
    const c2b = controller(settingsWith("block"), t2b, confirm, audited);
    expect(await c2b.beforeToolCall({ toolCall: { id: "t2b", name: "write" }, args: { path: "a.md", content: "x" } })).toBeUndefined();
    expect(t2b).not.toHaveBeenCalled();
    // Disabled guard never scanned.
    const off = { ...settingsWith("block"), jev: { ...settingsWith("block").jev, autoMode: { enabled: false, allowEgress: true, mode: "block" as const, tools: [], timeoutMs: 300, minConfidence: 0.8 } } };
    const t3 = vi.fn(RISKY);
    const c3 = controller(off, t3, confirm, audited);
    expect(await c3.beforeToolCall({ toolCall: { id: "t3", name: "delete" }, args: {} })).toBeUndefined();
    expect(t3).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("ask-policy paths never scan (the prompt is the protection)", async () => {
    const audited: unknown[] = [];
    const confirm = vi.fn(async () => ({ approved: true, remember: false }));
    const settings: AgenticChatSettings = {
      ...DEFAULT_SETTINGS,
      mode: "safe",
      approval: { mutating: "ask", perTool: {}, workingDirs: [] },
      jev: {
        ...DEFAULT_SETTINGS.jev,
        apiKey: KEY,
        autoMode: { enabled: true, allowEgress: true, mode: "block", tools: [], timeoutMs: 300, minConfidence: 0.8 },
      },
    };
    const t = vi.fn(RISKY);
    const c = new AgentToolCallController({
      app: {} as never,
      getSettings: () => settings,
      confirmToolCall: confirm as never,
      getTools: () => [{ name: "delete", label: "Delete" }] as never,
      getProfiles: () => [],
      onUndoApplied: () => {},
      recordApproval: (input) => {
        audited.push(input);
      },
      jevTransport: t,
    });
    expect(await c.beforeToolCall({ toolCall: { id: "t1", name: "delete" }, args: { path: "a.md" } })).toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(t).not.toHaveBeenCalled();
  });

  it("recursive delete takes the ask path without scanning (default config)", async () => {
    const audited: unknown[] = [];
    const confirm = vi.fn(async () => ({ approved: true, remember: false }));
    const t = vi.fn(RISKY);
    const c = controller(settingsWith("block"), t, confirm, audited);
    expect(
      await c.beforeToolCall({ toolCall: { id: "t1", name: "delete" }, args: { path: "Notes", recursive: true } }),
    ).toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(t).not.toHaveBeenCalled();
  });

  it("resolveApiKey takes precedence and tolerates rejection", async () => {
    const audited: unknown[] = [];
    const confirm = vi.fn(async () => ({ approved: true, remember: false }));
    const settings = settingsWith("block");
    const t = vi.fn(SAFE);
    const c = new AgentToolCallController({
      app: {} as never,
      getSettings: () => settings,
      confirmToolCall: confirm as never,
      getTools: () => [{ name: "delete", label: "Delete" }] as never,
      getProfiles: () => [],
      onUndoApplied: () => {},
      recordApproval: (input) => {
        audited.push(input);
      },
      resolveJevApiKey: () => Promise.reject(new Error("vault locked")),
      jevTransport: t,
    });
    // Resolver rejects but hydrated settings key still applies (fail-open chain).
    expect(await c.beforeToolCall({ toolCall: { id: "t1", name: "delete" }, args: { path: "a.md" } })).toBeUndefined();
    expect(t).toHaveBeenCalledTimes(1);
  });

  it("escalate-approve audits requested note + approval", async () => {
    const audited: { decision: string; reason?: string }[] = [];
    const confirm = vi.fn(async () => ({ approved: true, remember: false }));
    const c = controller(settingsWith("escalate"), RISKY, confirm, audited as unknown[]);
    expect(
      await c.beforeToolCall({ toolCall: { id: "t1", name: "delete" }, args: { path: "Notes/old.md" } }),
    ).toBeUndefined();
    expect(audited.find((a) => a.decision === "requested")?.reason).toMatch(/Jev AutoMode/);
    expect(audited.some((a) => a.decision === "approved")).toBe(true);
  });

  it("memoizes repeat assessments", async () => {
    const audited: unknown[] = [];
    const confirm = vi.fn(async () => ({ approved: true, remember: false }));
    const t = vi.fn(SAFE);
    const c = controller(settingsWith("block"), t, confirm, audited);
    const args = { path: "a.md" };
    await c.beforeToolCall({ toolCall: { id: "t1", name: "delete" }, args });
    await c.beforeToolCall({ toolCall: { id: "t2", name: "delete" }, args });
    expect(t).toHaveBeenCalledTimes(1);
  });
});
