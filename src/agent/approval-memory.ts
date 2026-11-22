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
  if (isNeverRememberedAllowTool(toolName) && policy === "allow") {
    // A persistent skill write (create_skill) must
    // never be silently auto-allowed: one fatigued "don't ask again" would
    // disarm the injection gate for all future calls. Remember deny, not allow.
    return false;
  }
  setPerToolApproval(settings.approval, toolName, policy);
  return true;
}

/**
 * Tools whose "Always allow" is never stored: a persistent skill package, and a
 * web download (it has no row in the per-tool settings, so a remembered allow
 * could never be seen or revoked there).
 */
function isNeverRememberedAllowTool(toolName: string): boolean {
  return toolName === "create_skill" || toolName === "download_file";
}
