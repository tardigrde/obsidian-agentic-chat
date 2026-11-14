import { Notice } from "obsidian";
import { DEFAULT_OUTPUT_STYLE } from "../../agent/output-styles";
import { formatCompactionSummary } from "../../agent/compaction";
import { EXPORT_FOLDER, exportFileName, hasExportableTurns, sessionToMarkdown } from "../../session/export";
import { writeVaultFile } from "../../vault/storage";
import { errorMessage } from "../../utils/errors";
import { SessionWorkflowController } from "../session-workflow-controller";
import { SessionListModal } from "../session-list-modal";
import type { SlashContext } from "./context";

export function createSessionWorkflow(ctx: SlashContext): SessionWorkflowController {
  return new SessionWorkflowController({
    listSessions: () => ctx.service.listSessions(),
    activeSessionPath: () => ctx.service.getSessionInfo()?.path ?? null,
    clearSessions: () => ctx.clearAllSessions(),
    loadSession: (path) => void ctx.loadSession(path),
    deleteSession: (path) => ctx.deleteSessionFromList(path),
    renameSession: (path, name) => ctx.service.renameSession(path, name),
    openList: (sessions, activePath, callbacks) =>
      new SessionListModal(ctx.app, sessions, activePath, callbacks).open(),
    afterClear: () => ctx.createSessionActivationCoordinator().afterSessionsCleared(),
    renderer: ctx.workflowRenderer(),
  });
}

export function runSessions(ctx: SlashContext, arg: string): Promise<void> {
  return ctx.createSessionWorkflow().run(arg);
}

export async function newSession(ctx: SlashContext): Promise<void> {
  const coordinator = ctx.createSessionActivationCoordinator();
  try {
    await coordinator.startNewConversation(() => ctx.service.newSession());
  } catch (error) {
    ctx.renderErrorMessage(errorMessage(error));
  } finally {
    // A new conversation starts in the default (normal) output style.
    await ctx.plugin.settingsStore.update((settings) => {
      if (settings.outputStyle === DEFAULT_OUTPUT_STYLE) return false;
      settings.outputStyle = DEFAULT_OUTPUT_STYLE;
    });
  }
}

/** `/compact [instructions]`: rewrite older transcript turns into a summary now. */
export async function runCompact(ctx: SlashContext, instructions = ""): Promise<void> {
  ctx.clearEmptyState();
  const compactPart = instructions.trim() ? ` ${instructions.trim()}` : "";
  const display = `/compact${compactPart}`;
  ctx.renderOutgoingUserMessage(display, []);
  const pending = new Notice("Compacting conversation…", 0);
  let result;
  try {
    result = await ctx.service.compactNow(instructions);
  } finally {
    pending.hide();
  }
  if (result.compacted) {
    ctx.renderTranscript(ctx.service.getMessages());
    ctx.syncChrome();
    ctx.renderInfoMessage("Compact", [["result", formatCompactionSummary(result)]]);
    return;
  }
  ctx.renderInfoMessage("Compact", [["result", result.message]]);
  ctx.showServiceError();
}

/** `/export`: write the active conversation to a Markdown note without changing active-note context. */
export async function exportSession(ctx: SlashContext): Promise<void> {
  ctx.clearEmptyState();
  const messages = ctx.service.getMessages();
  if (!hasExportableTurns(messages)) {
    ctx.renderInfoMessage("Export", [["Export", "Nothing to export yet — send a message first."]]);
    return;
  }
  try {
    const markdown = sessionToMarkdown(messages, ctx.service.getSessionInfo());
    const path = `${EXPORT_FOLDER}/${exportFileName(ctx.service.getSessionInfo(), Date.now())}`;
    const file = await writeVaultFile(ctx.app, path, markdown);
    ctx.renderInfoMessage("Export", [["Saved", file.path]]);
  } catch (error) {
    ctx.renderErrorMessage(`Export failed: ${errorMessage(error)}`);
  }
}

/** `/undo`: revert the agent's most recent vault change, reported in-pane. */
export async function runUndo(ctx: SlashContext): Promise<void> {
  ctx.clearEmptyState();
  const result = await ctx.service.undoLastChange();
  ctx.renderInfoMessage("Undo", [["result", result]]);
}
