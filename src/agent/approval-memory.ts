import type { AgenticChatSettings } from "../settings-schema";
import type { ApprovalPolicy } from "./approval";
import { setPerToolApproval } from "./approval";

export interface RememberableApprovalChoice {
  approved: boolean;
  remember: boolean;
}

export function approvalPolicyForRememberedChoice(choice: RememberableApprovalChoice): ApprovalPolicy | null {
  if (!choice.remember) return null;
  return choice.approved ? "allow" : "deny";
}

export function applyRememberedApprovalChoice(
  settings: AgenticChatSettings,
  toolName: string,
  choice: RememberableApprovalChoice,
): boolean {
  const policy = approvalPolicyForRememberedChoice(choice);
  if (!policy) return false;
  if (isPersistentSkillTool(toolName) && policy === "allow") {
    // A persistent skill write never remembers allow: one click would disarm the gate.
    return false;
  }
  setPerToolApproval(settings.approval, toolName, policy);
  return true;
}

/** Tools whose effect persists across sessions as a vault skill package. */
function isPersistentSkillTool(toolName: string): boolean {
  return toolName === "create_skill";
}
