import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODE,
  healMode,
  MODE_ORDER,
  MODES,
  resolveModePolicy,
  resolveModeTransition,
  TOGGLE_MODES,
  validateModeTransition,
} from "../src/agent/modes";
import { type ApprovalSettings } from "../src/agent/approval";

const allow: ApprovalSettings = { mutating: "allow", perTool: {} };

describe("MODES", () => {
  it("defaults to safe and exposes only Safe and YOLO", () => {
    expect(DEFAULT_MODE).toBe("safe");
    expect(MODE_ORDER[0]).toBe("safe");
    expect(MODE_ORDER).toEqual(["safe", "yolo"]);
    expect(new Set(MODE_ORDER)).toEqual(new Set(Object.keys(MODES)));
    expect(TOGGLE_MODES).toEqual(["safe", "yolo"]);
  });
});

describe("resolveModePolicy", () => {
  it("safe mode defers entirely to the approval policy", () => {
    expect(resolveModePolicy("safe", allow, "write").policy).toBe("allow");
    expect(resolveModePolicy("safe", { mutating: "ask", perTool: {} }, "edit").policy).toBe("ask");
    expect(resolveModePolicy("safe", { mutating: "deny", perTool: {} }, "write").policy).toBe("deny");
    expect(resolveModePolicy("safe", { mutating: "ask", perTool: {} }, "read").policy).toBe("allow");
  });

  it("yolo mode forces mutating tools to allow even when settings deny them", () => {
    expect(resolveModePolicy("yolo", { mutating: "deny", perTool: {} }, "write").policy).toBe("allow");
    expect(resolveModePolicy("yolo", { mutating: "ask", perTool: {} }, "edit").policy).toBe("allow");
  });

  it("yolo mode still honors an explicit per-tool deny (per-tool override wins)", () => {
    const decision = resolveModePolicy("yolo", { mutating: "allow", perTool: { write: "deny" } }, "write");
    expect(decision.policy).toBe("deny");
    // A per-tool ask is also respected under yolo.
    expect(resolveModePolicy("yolo", { mutating: "allow", perTool: { edit: "ask" } }, "edit").policy).toBe("ask");
  });

  it("yolo still allows read-only tools", () => {
    expect(resolveModePolicy("yolo", allow, "grep").policy).toBe("allow");
  });
});

describe("healMode", () => {
  it("keeps current modes and maps the retired ask/plan/agent set to safe", () => {
    expect(healMode("safe")).toBe("safe");
    expect(healMode("yolo")).toBe("yolo");
    expect(healMode("plan")).toBe("safe");
    expect(healMode("agent")).toBe("safe");
    expect(healMode("ask")).toBe("safe");
    expect(healMode("nonsense")).toBe(DEFAULT_MODE);
    expect(healMode(undefined)).toBe(DEFAULT_MODE);
  });
});

describe("validateModeTransition", () => {
  it("blocks while streaming", () => {
    expect(validateModeTransition(true)).toMatch(/Can't switch mode while the agent is responding/);
  });

  it("allows a transition when not streaming", () => {
    expect(validateModeTransition(false)).toBeNull();
  });
});

describe("resolveModeTransition", () => {
  it("returns null for a same-mode no-op", () => {
    expect(resolveModeTransition("safe", "safe")).toBeNull();
    expect(resolveModeTransition("yolo", "yolo")).toBeNull();
  });

  it("switches Safe ↔ YOLO with no residual state", () => {
    expect(resolveModeTransition("safe", "yolo")).toEqual({ nextMode: "yolo" });
    expect(resolveModeTransition("yolo", "safe")).toEqual({ nextMode: "safe" });
  });
});
