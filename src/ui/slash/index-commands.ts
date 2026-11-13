import { MemoryWorkflowController } from "../memory-workflow-controller";
import { SemanticIndexWorkflowController } from "../semantic-index-workflow-controller";
import {
  createMemoryWorkflowController,
  createSemanticIndexWorkflowController,
} from "../chat-services";
import type { SlashContext } from "./context";

export async function runSemanticIndex(ctx: SlashContext, arg: string): Promise<void> {
  await ctx.semanticIndexWorkflowController().run(arg);
}

export function createMemoryWorkflow(ctx: SlashContext): MemoryWorkflowController {
  return createMemoryWorkflowController({
    app: ctx.app,
    messages: () => ctx.service.getMessages(),
    sessionInfo: () => ctx.service.getSessionInfo(),
    renderer: ctx.workflowRenderer(),
  });
}

export function semanticIndexWorkflowController(ctx: SlashContext): SemanticIndexWorkflowController {
  if (ctx.semanticIndexWorkflow) return ctx.semanticIndexWorkflow;
  ctx.semanticIndexWorkflow = createSemanticIndexWorkflowController({
    app: ctx.app,
    settings: ctx.plugin.settings,
    pluginDir: ctx.plugin.manifest.dir,
    pluginId: ctx.plugin.manifest.id,
    activeNotePath: () => ctx.activeNotePath,
    isPathIgnored: (path) => ctx.service.isPathIgnored(path),
    renderer: ctx.workflowRenderer(),
  });
  return ctx.semanticIndexWorkflow;
}

export function runMemory(ctx: SlashContext, arg: string): Promise<void> {
  return ctx.createMemoryWorkflow().run(arg);
}
