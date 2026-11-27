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

/** Persist an "Always allow" / "Always deny" choice in the shared per-tool map. */
export function applyRememberedApprovalChoice(
  settings: AgenticChatSettings,
  toolName: string,
  choice: RememberableApprovalChoice,
): boolean {
  const policy = approvalPolicyForRememberedChoice(choice);
  if (!policy) return false;
  setPerToolApproval(settings.approval, toolName, policy);
  return true;
}
