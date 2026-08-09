import { describe, expect, it } from "vitest";
import {
  applyRememberedApprovalChoice,
  approvalPolicyForRememberedChoice,
} from "../src/agent/approval-memory";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";

function settings(): AgenticChatSettings {
  return {
    ...DEFAULT_SETTINGS,
    approval: { ...DEFAULT_SETTINGS.approval, perTool: {}, workingDirs: [] },
  };
}

describe("approval memory", () => {
  it("does not persist choices when remember is off", () => {
    expect(approvalPolicyForRememberedChoice({ approved: true, remember: false })).toBeNull();
    expect(approvalPolicyForRememberedChoice({ approved: false, remember: false })).toBeNull();

    const current = settings();
    expect(applyRememberedApprovalChoice(current, "write", { approved: true, remember: false })).toBe(false);
    expect(current.approval.perTool).toEqual({});
  });

  it("persists the final allow or deny decision for tools", () => {
    const allow = settings();
    expect(applyRememberedApprovalChoice(allow, "write", { approved: true, remember: true })).toBe(true);
    expect(allow.approval.perTool.write).toBe("allow");

    const deny = settings();
    expect(applyRememberedApprovalChoice(deny, "write", { approved: false, remember: true })).toBe(true);
    expect(deny.approval.perTool.write).toBe("deny");
  });
});
