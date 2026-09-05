import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODE,
  enterPlan,
  exitPlan,
  healMode,
  MODE_ORDER,
  MODES,
  resolveModePolicy,
  resolveModeTransition,
  TOGGLE_MODES,
  validateModeTransition,
} from "../src/agent/modes";
import { type ApprovalSettings } from "../src/agent/approval";
import { MUTATING_TOOLS } from "../src/tools/tool-contracts";

const allow: ApprovalSettings = { mutating: "allow", perTool: {}, workingDirs: [] };

describe("MODES", () => {
  it("defaults to safe and only plan carries a prompt overlay", () => {
    expect(DEFAULT_MODE).toBe("safe");
    expect(MODE_ORDER[0]).toBe("safe");
    expect(new Set(MODE_ORDER)).toEqual(new Set(Object.keys(MODES)));
    expect(TOGGLE_MODES).toEqual(["safe", "yolo"]);
    expect(MODES.safe.promptOverlay).toBe("");
    expect(MODES.yolo.promptOverlay).toBe("");
    expect(MODES.plan.promptOverlay).not.toBe("");
  });
});

describe("resolveModePolicy", () => {
  it("safe mode defers entirely to the approval policy", () => {
    expect(resolveModePolicy("safe", allow, "write").policy).toBe("allow");
    expect(resolveModePolicy("safe", { mutating: "ask", perTool: {}, workingDirs: [] }, "edit").policy).toBe("ask");
    expect(resolveModePolicy("safe", { mutating: "deny", perTool: {}, workingDirs: [] }, "write").policy).toBe("deny");
    expect(resolveModePolicy("safe", { mutating: "ask", perTool: {}, workingDirs: [] }, "read").policy).toBe("allow");
  });

  it("yolo mode forces mutating tools to allow even when settings deny them", () => {
    expect(resolveModePolicy("yolo", { mutating: "deny", perTool: {}, workingDirs: [] }, "write").policy).toBe("allow");
    expect(resolveModePolicy("yolo", { mutating: "ask", perTool: {}, workingDirs: [] }, "edit").policy).toBe("allow");
  });

  it("yolo mode still honors an explicit per-tool deny (per-tool override wins)", () => {
    const decision = resolveModePolicy("yolo", { mutating: "allow", perTool: { write: "deny" }, workingDirs: [] }, "write");
    expect(decision.policy).toBe("deny");
    // A per-tool ask is also respected under yolo.
    expect(resolveModePolicy("yolo", { mutating: "allow", perTool: { edit: "ask" }, workingDirs: [] }, "edit").policy).toBe("ask");
  });

  it("plan mode denies every tool outside the readonly allowlist, even when approval allows", () => {
    for (const tool of MUTATING_TOOLS) {
      const decision = resolveModePolicy("plan", allow, tool);
      expect(decision.policy).toBe("deny");
      expect(decision.reason).toMatch(/read-only/i);
      expect(decision.reason).toMatch(/plan/i);
    }
    // Subagent dispatch, MCP, and unknown tools are also blocked.
    expect(resolveModePolicy("plan", allow, "subagent").policy).toBe("deny");
    expect(resolveModePolicy("plan", allow, "mcp_test").policy).toBe("deny");
    expect(resolveModePolicy("plan", allow, "import_pdf").policy).toBe("deny");
    // remember_memory writes daily notes, so plan (read-only) blocks it too.
    expect(resolveModePolicy("plan", allow, "remember_memory").policy).toBe("deny");
  });

  it("plan and yolo still allow read-only tools", () => {
    expect(resolveModePolicy("plan", allow, "read").policy).toBe("allow");
    expect(resolveModePolicy("plan", allow, "grep").policy).toBe("allow");
    expect(resolveModePolicy("yolo", allow, "grep").policy).toBe("allow");
    // recall_memory is read-only search over MEMORY.md + dailies, so plan allows it.
    expect(resolveModePolicy("plan", allow, "recall_memory").policy).toBe("allow");
  });
});

describe("plan sticky transitions", () => {
  it("enterPlan remembers the prior posture and is a no-op when already planning", () => {
    expect(enterPlan("safe")).toEqual({ mode: "plan", previous: "safe" });
    expect(enterPlan("yolo")).toEqual({ mode: "plan", previous: "yolo" });
    expect(enterPlan("plan")).toBeNull();
  });

  it("exitPlan restores the remembered posture, defaulting when unknown", () => {
    expect(exitPlan("yolo")).toBe("yolo");
    expect(exitPlan("safe")).toBe("safe");
    expect(exitPlan(null)).toBe(DEFAULT_MODE);
    // Never restore back into plan even if that's what was stored.
    expect(exitPlan("plan")).toBe(DEFAULT_MODE);
  });
});

describe("healMode", () => {
  it("keeps current modes and maps the retired ask/plan/agent set", () => {
    expect(healMode("safe")).toBe("safe");
    expect(healMode("yolo")).toBe("yolo");
    expect(healMode("plan")).toBe("plan");
    expect(healMode("agent")).toBe("safe");
    expect(healMode("ask")).toBe("plan");
    expect(healMode("nonsense")).toBe(DEFAULT_MODE);
    expect(healMode(undefined)).toBe(DEFAULT_MODE);
  });
});

describe("validateModeTransition", () => {
  it("blocks while streaming regardless of target", () => {
    expect(validateModeTransition("safe", "yolo", true)).toMatch(/Can't switch mode while the agent is responding/);
    expect(validateModeTransition("safe", "plan", true)).toMatch(/Can't switch mode while the agent is responding/);
    expect(validateModeTransition("plan", "safe", true)).toMatch(/Can't switch mode while the agent is responding/);
  });

  it("allows same-mode no-op even without streaming block wording", () => {
    expect(validateModeTransition("safe", "safe", false)).toBeNull();
    expect(validateModeTransition("yolo", "yolo", false)).toBeNull();
    expect(validateModeTransition("plan", "plan", false)).toBeNull();
  });

  it("blocks plan→yolo when not restoring previous yolo", () => {
    expect(validateModeTransition("plan", "yolo", false, null)).toMatch(/Can't switch to YOLO while in plan mode/);
    expect(validateModeTransition("plan", "yolo", false, "safe")).toMatch(/Can't switch to YOLO while in plan mode/);
  });

  it("allows plan→yolo when restoring previous yolo posture", () => {
    expect(validateModeTransition("plan", "yolo", false, "yolo")).toBeNull();
  });

  it("allows plan→safe", () => {
    expect(validateModeTransition("plan", "safe", false, null)).toBeNull();
    expect(validateModeTransition("plan", "safe", false, "safe")).toBeNull();
  });

  it("allows safe↔yolo and safe/yolo→plan", () => {
    expect(validateModeTransition("safe", "yolo", false)).toBeNull();
    expect(validateModeTransition("yolo", "safe", false)).toBeNull();
    expect(validateModeTransition("safe", "plan", false)).toBeNull();
    expect(validateModeTransition("yolo", "plan", false)).toBeNull();
  });
});

describe("resolveModeTransition", () => {
  it("returns null for same-mode no-op", () => {
    expect(resolveModeTransition("safe", "safe", null)).toBeNull();
    expect(resolveModeTransition("plan", "plan", "safe")).toBeNull();
  });

  it("x→plan remembers previous posture", () => {
    expect(resolveModeTransition("safe", "plan", null)).toEqual({ nextMode: "plan", nextPrevious: "safe" });
    expect(resolveModeTransition("yolo", "plan", "safe")).toEqual({ nextMode: "plan", nextPrevious: "yolo" });
  });

  it("plan→x clears remembered posture", () => {
    expect(resolveModeTransition("plan", "safe", "yolo")).toEqual({ nextMode: "safe", nextPrevious: null });
    expect(resolveModeTransition("plan", "yolo", "yolo")).toEqual({ nextMode: "yolo", nextPrevious: null });
  });

  it("blocks plan→yolo escalation when not restoring", () => {
    expect(resolveModeTransition("plan", "yolo", null)).toBeNull();
    expect(resolveModeTransition("plan", "yolo", "safe")).toBeNull();
  });

  it("preserves plan memory on safe↔yolo, heals stale plan previous", () => {
    expect(resolveModeTransition("safe", "yolo", null)).toEqual({ nextMode: "yolo", nextPrevious: null });
    expect(resolveModeTransition("safe", "yolo", "safe" as never)).toEqual({ nextMode: "yolo", nextPrevious: "safe" });
    // stale previous === "plan" is healed to null
    expect(resolveModeTransition("safe", "yolo", "plan")).toEqual({ nextMode: "yolo", nextPrevious: null });
  });

  it("yolo→plan→yolo round-trip restores correctly via resolve+validate", () => {
    const entered = resolveModeTransition("yolo", "plan", null)!;
    expect(entered.nextPrevious).toBe("yolo");
    expect(validateModeTransition("plan", "yolo", false, entered.nextPrevious)).toBeNull();
    const exited = resolveModeTransition("plan", "yolo", entered.nextPrevious)!;
    expect(exited.nextMode).toBe("yolo");
    expect(exited.nextPrevious).toBeNull();
  });

  it("safe→plan→safe round-trip overwrites stale previous on re-entry", () => {
    const first = resolveModeTransition("safe", "plan", null)!;
    expect(first.nextPrevious).toBe("safe");
    const back = resolveModeTransition("plan", "safe", first.nextPrevious)!;
    expect(back.nextMode).toBe("safe");
    // re-entering plan should capture fresh previous, not stale
    const second = resolveModeTransition("yolo", "plan", back.nextPrevious)!;
    expect(second.nextPrevious).toBe("yolo");
  });
});
