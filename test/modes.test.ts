import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODE,
  enterPlan,
  exitPlan,
  healMode,
  MODE_ORDER,
  MODES,
  resolveModePolicy,
  TOGGLE_MODES,
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

  it("plan mode denies every mutating tool with a read-only reason, even when approval allows", () => {
    for (const tool of MUTATING_TOOLS) {
      const decision = resolveModePolicy("plan", allow, tool);
      expect(decision.policy).toBe("deny");
      expect(decision.reason).toMatch(/read-only/i);
      expect(decision.reason).toMatch(/plan/i);
    }
  });

  it("plan and yolo still allow read-only tools", () => {
    expect(resolveModePolicy("plan", allow, "read").policy).toBe("allow");
    expect(resolveModePolicy("yolo", allow, "grep").policy).toBe("allow");
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
