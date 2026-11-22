import { describe, expect, it } from "vitest";
import { type ApprovalSettings, resolvePolicy } from "../src/agent/approval";
import { resolveModePolicy } from "../src/agent/modes";
import { MUTATING_TOOLS } from "../src/tools/tool-contracts";

const base: ApprovalSettings = { mutating: "ask", perTool: {} };

describe("resolvePolicy", () => {
  it("always allows read-only tools", () => {
    expect(resolvePolicy(base, "read")).toBe("allow");
    expect(resolvePolicy(base, "grep")).toBe("allow");
  });

  it("applies the mutating policy to write/edit/delete/rename", () => {
    for (const tool of MUTATING_TOOLS) {
      expect(resolvePolicy(base, tool)).toBe("ask");
    }
    expect(resolvePolicy({ mutating: "deny", perTool: {} }, "write")).toBe("deny");
  });

  it("treats download_file as mutating: it asks in Safe, and YOLO allows it", () => {
    expect(MUTATING_TOOLS.has("download_file")).toBe(true);
    expect(resolvePolicy(base, "download_file")).toBe("ask");
    expect(resolvePolicy({ mutating: "allow", perTool: {} }, "download_file")).toBe("allow");
    // The YOLO overlay itself forces the mutating default to allow.
    expect(resolveModePolicy("yolo", { mutating: "ask", perTool: {} }, "download_file").policy).toBe("allow");
    expect(resolveModePolicy("safe", { mutating: "ask", perTool: {} }, "download_file").policy).toBe("ask");
    expect(resolvePolicy({ mutating: "ask", perTool: { download_file: "deny" } }, "download_file")).toBe("deny");
  });

  it("honors explicit per-tool overrides for either direction", () => {
    expect(resolvePolicy({ mutating: "ask", perTool: { write: "allow" } }, "write")).toBe("allow");
    expect(resolvePolicy({ mutating: "ask", perTool: { read: "deny" } }, "read")).toBe("deny");
  });
});
