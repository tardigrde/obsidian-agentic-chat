import type { AgenticChatSettings } from "../settings";
import { EXTERNAL_INSPECT_TOOL_NAME } from "../tools/external-workspace";
import type { ApprovalPolicy } from "./approval";

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
  if (toolName === EXTERNAL_INSPECT_TOOL_NAME) {
    settings.external.approval = policy;
  } else {
    settings.approval.perTool[toolName] = policy;
  }
  return true;
}
