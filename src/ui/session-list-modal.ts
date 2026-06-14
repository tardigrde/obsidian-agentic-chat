import { App, Modal, setIcon } from "obsidian";
import type { SessionInfo } from "../session/session-manager";

export interface SessionListCallbacks {
  load: (session: SessionInfo) => void;
  delete: (session: SessionInfo) => Promise<void>;
  rename: (session: SessionInfo, name: string) => Promise<void>;
}

/** Browse, resume, or delete past conversations. */
export class SessionListModal extends Modal {
  private sessions: SessionInfo[];

  constructor(
    app: App,
    sessions: SessionInfo[],
    private readonly activePath: string | null,
    private readonly callbacks: SessionListCallbacks,
  ) {
    super(app);
    // Own a mutable copy so sequential deletes shrink the list instead of
    // re-filtering a stale snapshot (which made deleted rows reappear).
    this.sessions = [...sessions];
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Conversations");
    contentEl.addClass("agentic-chat-session-list");
    this.renderList(this.sessions);
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderList(sessions: SessionInfo[]): void {
    const list = this.contentEl;
    list.empty();
    if (sessions.length === 0) {
      list.createEl("p", { text: "No saved conversations yet." });
      return;
    }
    for (const session of sessions) {
      const row = list.createDiv({ cls: "agentic-chat-session-row" });
      if (session.path === this.activePath) row.addClass("is-active");

      const main = row.createDiv({ cls: "agentic-chat-session-main" });
      const titleEl = main.createDiv({ cls: "agentic-chat-session-title", text: title(session) });
      main.createDiv({
        cls: "agentic-chat-session-meta",
        text: `${session.messageCount} message${session.messageCount === 1 ? "" : "s"} · ${formatWhen(session.updatedAt)}`,
      });
      main.addEventListener("click", () => {
        this.callbacks.load(session);
        this.close();
      });

      const rename = row.createDiv({ cls: "agentic-chat-session-rename clickable-icon", attr: { "aria-label": "Rename" } });
      setIcon(rename, "pencil");
      rename.addEventListener("click", (event) => {
        event.stopPropagation();
        this.beginRename(session, titleEl);
      });

      const remove = row.createDiv({ cls: "agentic-chat-session-delete clickable-icon", attr: { "aria-label": "Delete" } });
      setIcon(remove, "trash-2");
      remove.addEventListener("click", async (event) => {
        event.stopPropagation();
        // Optimistically drop the row first: keeps the list responsive and
        // stops a quick second click from deleting the same session twice.
        this.sessions = this.sessions.filter((item) => item.path !== session.path);
        this.renderList(this.sessions);
        try {
          await this.callbacks.delete(session);
        } catch (error) {
          console.error("Agentic chat: failed to delete session", error);
        }
      });
    }
  }

  /** Swap a session's title for an inline text input; commit on Enter/blur. */
  private beginRename(session: SessionInfo, titleEl: HTMLElement): void {
    // A rename is already in progress on this row — don't stack inputs/listeners.
    if (titleEl.querySelector(".agentic-chat-session-rename-input")) return;
    const hadCustomName = !!session.name?.trim();
    const current = session.name?.trim() || session.firstMessage;
    const input = titleEl.createEl("input", {
      cls: "agentic-chat-session-rename-input",
      attr: { type: "text", value: current === "(no messages)" ? "" : current },
    });
    titleEl.firstChild?.remove();
    input.focus();
    input.select();
    let committed = false;
    const commit = async (save: boolean): Promise<void> => {
      if (committed) return;
      committed = true;
      const next = input.value.trim();
      // Rename to a new title, or clear a previously-set custom name (empty input).
      const shouldCommit = save && next !== current && (next.length > 0 || hadCustomName);
      if (shouldCommit) {
        try {
          await this.callbacks.rename(session, next);
          // Only update the in-memory name once the rename actually persisted.
          session.name = next || undefined;
        } catch (error) {
          console.error("Agentic chat: failed to rename session", error);
        }
      }
      this.renderList(this.sessions);
    };
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void commit(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        void commit(false);
      }
    });
    input.addEventListener("blur", () => void commit(true));
  }
}

function title(session: SessionInfo): string {
  const text = session.name?.trim() || session.firstMessage;
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > 80 ? `${single.slice(0, 80)}…` : single || "(empty conversation)";
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
