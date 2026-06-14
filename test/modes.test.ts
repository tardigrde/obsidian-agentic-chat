import { describe, expect, it } from "vitest";
import { DEFAULT_MODE, MODE_ORDER, MODES, resolveModePolicy } from "../src/agent/modes";
import { type ApprovalSettings } from "../src/agent/approval";
import { MUTATING_TOOLS } from "../src/tools/vault-tools";

const approval: ApprovalSettings = { mutating: "allow", perTool: {} };

describe("MODES", () => {
  it("orders every mode with agent first and only the default has no overlay", () => {
    expect(MODE_ORDER[0]).toBe("agent");
    expect(new Set(MODE_ORDER)).toEqual(new Set(Object.keys(MODES)));
    expect(MODES[DEFAULT_MODE].promptOverlay).toBe("");
    expect(MODES.ask.promptOverlay).not.toBe("");
    expect(MODES.plan.promptOverlay).not.toBe("");
  });
});

describe("resolveModePolicy", () => {
  it("agent mode defers entirely to the approval policy", () => {
    expect(resolveModePolicy("agent", approval, "write").policy).toBe("allow");
    expect(resolveModePolicy("agent", { mutating: "ask", perTool: {} }, "edit").policy).toBe("ask");
    expect(resolveModePolicy("agent", approval, "read").policy).toBe("allow");
  });

  it("ask mode denies every mutating tool with a read-only reason, even when approval allows", () => {
    for (const tool of MUTATING_TOOLS) {
      const decision = resolveModePolicy("ask", approval, tool);
      expect(decision.policy).toBe("deny");
      expect(decision.reason).toMatch(/read-only/i);
    }
  });

  it("plan mode denies mutating tools with a plan-first reason", () => {
    const decision = resolveModePolicy("plan", approval, "write");
    expect(decision.policy).toBe("deny");
    expect(decision.reason).toMatch(/plan/i);
  });

  it("ask and plan modes still allow read-only tools", () => {
    expect(resolveModePolicy("ask", approval, "read").policy).toBe("allow");
    expect(resolveModePolicy("plan", approval, "grep").policy).toBe("allow");
  });
});
