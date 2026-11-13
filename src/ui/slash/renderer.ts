import type { WorkflowRenderer } from "../workflow-renderer";
import type { SlashContext } from "./context";

export function createWorkflowRenderer(ctx: SlashContext): WorkflowRenderer {
  return {
    clear: () => ctx.clearEmptyState(),
    info: (title, entries) => ctx.renderInfoMessage(title, entries),
    error: (message) => ctx.renderErrorMessage(message),
    actionList: (title, subtitle, items) => ctx.renderActionList(title, subtitle, items),
  };
}
