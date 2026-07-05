import type { SessionInfo } from "../session/session-manager";
import type { SessionListCallbacks } from "./session-list-modal";
import type { WorkflowRenderer } from "./workflow-renderer";

export interface SessionWorkflowControllerOptions {
  listSessions: () => Promise<SessionInfo[]>;
  activeSessionPath: () => string | null;
  clearSessions: () => Promise<number>;
  loadSession: (path: string) => void;
  deleteSession: (path: string) => Promise<void>;
  renameSession: (path: string, name: string) => Promise<void>;
  openList: (sessions: SessionInfo[], activePath: string | null, callbacks: SessionListCallbacks) => void;
  afterClear: () => void;
  renderer: WorkflowRenderer;
}

export class SessionWorkflowController {
  constructor(private readonly options: SessionWorkflowControllerOptions) {}

  async run(arg: string): Promise<void> {
    this.options.renderer.clear();
    const [subcommand, ...rest] = arg.trim().split(/\s+/).filter(Boolean);
    if (!subcommand) {
      await this.openList();
      return;
    }
    if (subcommand !== "clear") {
      this.options.renderer.error('Usage: /sessions [clear --confirm]');
      return;
    }
    if (!rest.includes("--confirm")) {
      this.options.renderer.error("This deletes all conversations in the current session scope. Re-run with /sessions clear --confirm.");
      return;
    }
    const deleted = await this.options.clearSessions();
    this.options.afterClear();
    this.options.renderer.info("Conversations", [["Deleted", `${deleted} conversation${deleted === 1 ? "" : "s"}.`]]);
  }

  private async openList(): Promise<void> {
    const sessions = (await this.options.listSessions()).filter((session) => session.messageCount > 0);
    this.options.openList(sessions, this.options.activeSessionPath(), {
      load: (session) => this.options.loadSession(session.path),
      delete: (session) => this.options.deleteSession(session.path),
      rename: (session, name) => this.options.renameSession(session.path, name),
    });
  }
}
