import { App, Modal, Notice, setIcon } from "obsidian";
import type { SessionInfo } from "../session/session-manager";
import {
  applySessionRename,
  emptySessionMessage,
  removeSessionByPath,
  resolveSessionRename,
  sessionRenameDraft,
  sessionRows,
} from "./session-list-state";

export { filterSessions } from "./session-list-state";

export interface SessionListCallbacks {
  load: (session: SessionInfo) => void;
  delete: (session: SessionInfo) => Promise<void>;
  rename: (session: SessionInfo, name: string) => Promise<void>;
}

/** How long after the last keystroke the search re-filters the list. */
const SEARCH_DEBOUNCE_MS = 150;

/** Browse, resume, or delete past conversations. */
export class SessionListModal extends Modal {
  private sessions: SessionInfo[];
  private query = "";
  private listEl: HTMLElement | null = null;
  private searchTimer: number | null = null;

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

    // Only offer search once there's enough to scroll through.
    if (this.sessions.length > 1) {
      const search = contentEl.createEl("input", {
        cls: "agentic-chat-session-search",
        attr: { type: "search", placeholder: "Search conversations…" },
      });
      search.focus();
      search.addEventListener("input", () => {
        this.query = search.value;
        // Debounce so each keystroke doesn't rebuild the whole list.
        if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
        this.searchTimer = window.setTimeout(() => {
          this.searchTimer = null;
          this.renderList();
        }, SEARCH_DEBOUNCE_MS);
      });
    }

    this.listEl = contentEl.createDiv({ cls: "agentic-chat-session-rows" });
    this.renderList();
  }

  onClose(): void {
    if (this.searchTimer !== null) window.clearTimeout(this.searchTimer);
    this.contentEl.empty();
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    const rows = sessionRows(this.sessions, this.query, this.activePath);
    if (rows.length === 0) {
      list.createEl("p", { cls: "agentic-chat-session-empty", text: emptySessionMessage(this.sessions.length) });
      return;
    }
    for (const rowState of rows) {
      const { session } = rowState;
      const row = list.createDiv({ cls: "agentic-chat-session-row" });
      if (rowState.active) row.addClass("is-active");

      const main = row.createDiv({ cls: "agentic-chat-session-main" });
      const titleEl = main.createDiv({ cls: "agentic-chat-session-title", text: rowState.title });
      main.createDiv({ cls: "agentic-chat-session-meta", text: rowState.meta });
      main.addEventListener("click", () => {
        this.callbacks.load(session);
        this.close();
      });

      const rename = row.createEl("button", {
        cls: "agentic-chat-session-rename clickable-icon",
        attr: { type: "button", "aria-label": "Rename" },
      });
      setIcon(rename, "pencil");
      rename.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      rename.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.beginRename(session, titleEl);
      });

      const remove = row.createEl("button", {
        cls: "agentic-chat-session-delete clickable-icon",
        attr: { type: "button", "aria-label": "Delete" },
      });
      setIcon(remove, "trash-2");
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        // Optimistically drop the row first: keeps the list responsive and
        // stops a quick second click from deleting the same session twice.
        this.sessions = removeSessionByPath(this.sessions, session.path);
        this.renderList();
        void this.deleteSession(session);
      });
    }
  }

  private async deleteSession(session: SessionInfo): Promise<void> {
    try {
      await this.callbacks.delete(session);
    } catch (error) {
      console.error("Agentic chat: failed to delete session", error);
    }
  }

  /** Swap a session's title for an inline text input; commit on Enter/blur. */
  private beginRename(session: SessionInfo, titleEl: HTMLElement): void {
    // A rename is already in progress on this row — don't stack inputs/listeners.
    if (titleEl.querySelector(".agentic-chat-session-rename-input")) return;
    const current = sessionRenameDraft(session);
    const input = titleEl.createEl("input", {
      cls: "agentic-chat-session-rename-input",
      attr: { type: "text", value: current },
    });
    titleEl.firstChild?.remove();
    input.focus();
    input.select();
    let committed = false;
    let blurArmed = false;
    const commit = async (save: boolean): Promise<void> => {
      if (committed) return;
      committed = true;
      const next = resolveSessionRename(session, input.value, save);
      if (next !== null) {
        try {
          await this.callbacks.rename(session, next);
          // Only update the in-memory name once the rename actually persisted.
          Object.assign(session, applySessionRename(session, next));
        } catch (error) {
          console.error("Agentic chat: failed to rename session", error);
          new Notice("Failed to rename conversation.");
        }
      }
      this.renderList();
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
    window.setTimeout(() => {
      blurArmed = true;
    }, 100);
    input.addEventListener("blur", () => {
      if (!blurArmed) {
        input.focus();
        return;
      }
      void commit(true);
    });
  }
}
