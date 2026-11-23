import type { AgentService } from "../agent/agent-service";
import type { ChatTabs } from "./chat-tabs";
import {
  parseSlashInput,
  retiredCommandHint,
  slashInputTailAfterFirst,
  type ParsedSlashInput,
  type SlashCommandName,
} from "./commands";
import { runAgent, runInit, runSkill } from "./slash/agents";
import type { SlashContext } from "./slash/context";
import { runDoctor, showHelp, showUsage } from "./slash/info";
import { runEffort, switchModel } from "./slash/model";
import { createWorkflowRenderer } from "./slash/renderer";
import { createSessionWorkflow, exportSession, newSession, runCompact, runSessions, runUndo } from "./slash/session";
import type { SessionWorkflowController } from "./session-workflow-controller";
import type { WorkflowRenderer } from "./workflow-renderer";
import { errorMessage } from "../utils/errors";

export interface ChatActionsDeps {
  slashCtx: () => SlashContext;
  service: () => AgentService;
  tabs: () => ChatTabs;
  switchToTab: (index: number) => Promise<void>;
  loadConversation: (load: () => Promise<void>) => Promise<void>;
  clearQueuedPrompt: () => void;
  clearEmptyState: () => void;
  renderErrorMessage: (message: string) => void;
  renderInfoMessage: (title: string, entries: Array<[string, string]>) => void;
}

/**
 * Owns slash dispatch and the session/model actions that commands and chrome
 * buttons share. Slash handlers still live under `./slash/`; this class is the
 * one place that routes user words to them.
 */
export class ChatActions {
  constructor(private readonly deps: ChatActionsDeps) {}

  async handleSlashCommand(raw: string): Promise<boolean> {
    const input = parseSlashInput(raw);
    const { word, argString, command } = input;
    if (!command) {
      // A bare /<skill-name> runs that skill directly (built-in commands take
      // precedence — a shadowed skill stays reachable via /skill <name>).
      const skill = this.deps.service().getSkills().find((item) => item.name.toLowerCase() === word.toLowerCase());
      if (skill) {
        const argPart = argString ? ` ${argString}` : "";
        await this.runSkill(skill.name, argString, `/${word}${argPart}`);
        return true;
      }
      return this.showRetiredCommandHint(word) || this.showUnknownCommandHint(word);
    }
    await this.slashHandlers(input)[command.name]();
    return true;
  }

  /**
   * One handler per built-in command. The `Record` type makes the compiler
   * reject a command in `SLASH_COMMANDS` that has no handler here.
   */
  private slashHandlers(input: ParsedSlashInput): Record<SlashCommandName, () => unknown> {
    const { argString } = input;
    return {
      new: () => this.newSession(),
      effort: () => this.runEffort(argString),
      sessions: () => this.runSessions(argString),
      model: () => this.switchModel(),
      doctor: () => this.runDoctor(),
      usage: () => this.showUsage(),
      compact: () => this.runCompact(argString),
      export: () => this.exportSession(),
      undo: () => this.runUndo(),
      skill: () => this.runSkill(input.args[0], slashInputTailAfterFirst(input)),
      agent: () => this.runAgent(input.args[0], slashInputTailAfterFirst(input)),
      init: () => this.runInit(argString),
      help: () => this.showHelp(),
    };
  }

  newSession(): Promise<void> { return newSession(this.deps.slashCtx()); }

  runSessions(arg: string): unknown { return runSessions(this.deps.slashCtx(), arg); }

  switchModel(): Promise<void> { return switchModel(this.deps.slashCtx()); }

  runDoctor(): Promise<void> { return runDoctor(this.deps.slashCtx()); }

  createSessionWorkflow(): SessionWorkflowController { return createSessionWorkflow(this.deps.slashCtx()); }

  runSkill(name: string | undefined, extra: string, display?: string): Promise<void> {
    return runSkill(this.deps.slashCtx(), name, extra, display);
  }

  runInit(instructions = ""): Promise<void> { return runInit(this.deps.slashCtx(), instructions); }

  runCompact(instructions = ""): Promise<void> { return runCompact(this.deps.slashCtx(), instructions); }


  runEffort(arg: string): void { runEffort(this.deps.slashCtx(), arg); }

  runAgent(name: string | undefined, task: string): Promise<void> {
    return runAgent(this.deps.slashCtx(), name, task);
  }

  workflowRenderer(): WorkflowRenderer { return createWorkflowRenderer(this.deps.slashCtx()); }


  runUndo(): Promise<void> { return runUndo(this.deps.slashCtx()); }

  showUsage(): void { showUsage(this.deps.slashCtx()); }

  exportSession(): Promise<void> { return exportSession(this.deps.slashCtx()); }

  showHelp(): void { showHelp(this.deps.slashCtx()); }

  /** Delete from the history list; a tab that has the session open swaps to a fresh one. */
  async deleteSessionFromList(path: string): Promise<void> {
    // A background tab that has the conversation open lets go of it first, in
    // its own queue. Otherwise it keeps appending to the deleted file, which
    // comes back without a session header: gone from history, lost on reload.
    await this.releaseInBackgroundTabs(new Set([path]));
    if (this.deps.service().getSessionInfo()?.path === path) this.deps.clearQueuedPrompt();
    // Let the history modal restore its optimistically removed row and show
    // the delete failure. Swallowing the rejection would leave the row gone.
    await this.deps.service().deleteSession(path);
  }

  /**
   * Clear all conversations; the active session is replaced afterwards.
   * Returns -1 on failure so the caller does not report success or reset the
   * transcript after a failed clear.
   */
  async clearAllSessions(): Promise<number> {
    this.deps.clearQueuedPrompt();
    let deleted: string[];
    try {
      deleted = await this.deps.service().clearSessions();
    } catch (error) {
      this.deps.renderErrorMessage(errorMessage(error));
      return -1;
    }
    // The clear deleted files that background tabs may have open, or were
    // loading while it ran. Each of those tabs starts a fresh session.
    await this.releaseInBackgroundTabs(new Set(deleted));
    return deleted.length;
  }

  /**
   * Every background tab checks, in its own queue, whether its session is in
   * `paths`, and starts a fresh one if so. A failure in one tab is reported
   * and does not stop the others or fail the delete.
   */
  private async releaseInBackgroundTabs(paths: ReadonlySet<string>): Promise<void> {
    const tabs = this.deps.tabs();
    const background = tabs.allTabs().filter((_tab, index) => index !== tabs.activeIndexValue);
    for (const tab of background) {
      const path = tab.service.getSessionInfo()?.path;
      if (path && paths.has(path)) tab.state.queuedPromptArmed = false;
      try {
        await tab.service.releaseDeletedSession(paths);
      } catch (error) {
        this.deps.renderErrorMessage(`A background tab could not start a fresh conversation: ${errorMessage(error)}`);
      }
    }
  }

  async loadSession(path: string): Promise<void> {
    const tabs = this.deps.tabs();
    // A session must not be open in two tabs at once (both would write the same
    // file). If another tab already has it, just switch there.
    const openIn = tabs.findIndex(
      (tab, index) => index !== tabs.activeIndexValue && tab.service.getSessionInfo()?.path === path,
    );
    if (openIn >= 0) {
      await this.deps.switchToTab(openIn);
      return;
    }
    try {
      await this.deps.loadConversation(() => this.deps.service().loadSession(path));
    } catch (error) {
      this.deps.renderErrorMessage(errorMessage(error));
    }
  }

  /**
   * A removed command (or alias) names its replacement instead of reaching the
   * model as a literal prompt. Returns false for words that were never commands.
   */
  showRetiredCommandHint(word: string): boolean {
    const hint = retiredCommandHint(word);
    if (!hint) return false;
    this.deps.clearEmptyState();
    this.deps.renderInfoMessage("Removed command", [[`/${word.toLowerCase()}`, hint]]);
    return true;
  }

  /**
   * A word that looks like a command but is none (a typo such as `/sesions`)
   * shows a hint instead of costing a model call. Text that only starts with a
   * slash, such as a path (`/home/me/notes`), still goes to the model.
   */
  showUnknownCommandHint(word: string): boolean {
    if (!looksLikeCommand(word)) return false;
    this.deps.clearEmptyState();
    this.deps.renderInfoMessage("Unknown command", [
      [`/${word}`, "is not a command or a skill. Type /help for the list, or remove the slash to send it as a message."],
    ]);
    return true;
  }
}

/** A command or skill name: a letter, then letters, digits, `-`, `_`, or `.`. No `/` (a path). */
function looksLikeCommand(word: string): boolean {
  return /^[A-Za-z][\w.-]*$/.test(word);
}
