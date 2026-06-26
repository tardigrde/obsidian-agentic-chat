import { describe, expect, it } from "vitest";
import { type ApprovalSettings, resolvePolicy } from "../src/agent/approval";
import { MUTATING_TOOLS } from "../src/tools/tool-contracts";

const base: ApprovalSettings = { mutating: "ask", perTool: {}, workingDirs: [] };

describe("resolvePolicy", () => {
  it("always allows read-only tools", () => {
    expect(resolvePolicy(base, "read")).toBe("allow");
    expect(resolvePolicy(base, "grep")).toBe("allow");
  });

  it("applies the mutating policy to write/edit/delete/rename", () => {
    for (const tool of MUTATING_TOOLS) {
      expect(resolvePolicy(base, tool)).toBe("ask");
    }
    expect(resolvePolicy({ mutating: "deny", perTool: {}, workingDirs: [] }, "write")).toBe("deny");
  });

  it("honors explicit per-tool overrides for either direction", () => {
    expect(resolvePolicy({ mutating: "ask", perTool: { write: "allow" }, workingDirs: [] }, "write")).toBe("allow");
    expect(resolvePolicy({ mutating: "ask", perTool: { read: "deny" }, workingDirs: [] }, "read")).toBe("deny");
  });
});
