import type { AgenticChatSettings } from "../settings";
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
    // Persistent prompt-implant primitives (create/load/unload_skill) must
    // never be silently auto-allowed: one fatigued "don't ask again" would
    // disarm the injection gate for all future calls. Remember deny, not allow.
    return false;
  }
  setPerToolApproval(settings.approval, toolName, policy);
  return true;
}

/** Tools whose effect persists across sessions via the prompt overlay or vault packages. */
function isPersistentSkillTool(toolName: string): boolean {
  return toolName === "create_skill" || toolName === "load_skill" || toolName === "unload_skill";
}
