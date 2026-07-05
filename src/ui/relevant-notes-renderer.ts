import { setIcon } from "obsidian";
import type { RelevantNotesPanelState } from "../retrieval/relevant-notes";

const COMPACT_VISIBLE_RELEVANT_NOTES = 2;

export interface RelevantNotesPanelCallbacks {
  attach: (path: string) => void;
  togglePin: (path: string, pinned: boolean) => void;
  exclude: (path: string) => void;
}

export function renderRelevantNotesPanel(
  parent: HTMLElement,
  state: RelevantNotesPanelState,
  callbacks: RelevantNotesPanelCallbacks,
): void {
  parent.empty();
  if (!state.activePath) {
    parent.hide();
    return;
  }
  parent.show();

  if (state.suggestions.length === 0) {
    const summary = parent.createDiv({ cls: ["agentic-chat-relevant-summary", "is-empty"] });
    const title = summary.createDiv({ cls: "agentic-chat-relevant-summary-title" });
    const icon = title.createSpan({ cls: "agentic-chat-relevant-title-icon" });
    setIcon(icon, "network");
    title.createSpan({ text: "Related: 0" });
    summary.createDiv({
      cls: "agentic-chat-relevant-empty",
      text: relevantNotesEmptyText(state.emptyReason),
    });
    return;
  }

  const details = parent.createEl("details", { cls: "agentic-chat-relevant-details" });
  const summary = details.createEl("summary", {
    cls: "agentic-chat-relevant-summary",
    attr: { "aria-label": `Show ${state.suggestions.length} related notes` },
  });
  const title = summary.createDiv({ cls: "agentic-chat-relevant-summary-title" });
  const icon = title.createSpan({ cls: "agentic-chat-relevant-title-icon" });
  setIcon(icon, "network");
  title.createSpan({ text: `Related: ${state.suggestions.length}` });

  const chips = summary.createDiv({ cls: "agentic-chat-relevant-summary-chips" });
  for (const suggestion of state.suggestions.slice(0, COMPACT_VISIBLE_RELEVANT_NOTES)) {
    const label = relevantNoteFileName(suggestion.path);
    chips.createSpan({ cls: "agentic-chat-relevant-summary-chip", text: label, attr: { title: suggestion.path } });
  }
  const remaining = state.suggestions.length - COMPACT_VISIBLE_RELEVANT_NOTES;
  if (remaining > 0) {
    chips.createSpan({ cls: "agentic-chat-relevant-summary-more", text: `+${remaining}` });
  }
  const chevron = summary.createSpan({ cls: "agentic-chat-relevant-chevron" });
  setIcon(chevron, "chevron-right");

  const list = details.createDiv({ cls: "agentic-chat-relevant-list" });
  for (const suggestion of state.suggestions) {
    const row = list.createDiv({ cls: suggestion.pinned ? ["agentic-chat-relevant-row", "is-pinned"] : "agentic-chat-relevant-row" });
    const reason = suggestion.why[0] ?? "";
    const attach = row.createEl("button", {
      cls: "agentic-chat-relevant-main",
      attr: { "aria-label": reason ? `Attach ${suggestion.path}: ${reason}` : `Attach ${suggestion.path}` },
    });
    const attachIcon = attach.createSpan({ cls: "agentic-chat-relevant-row-icon" });
    setIcon(attachIcon, "file-plus");
    const text = attach.createDiv({ cls: "agentic-chat-relevant-row-text" });
    const title = relevantNoteFileName(suggestion.path);
    text.createSpan({ cls: "agentic-chat-relevant-row-title", text: title, attr: { title: suggestion.path } });
    if (reason) text.createSpan({ cls: "agentic-chat-relevant-row-reason", text: reason, attr: { title: reason } });
    attach.addEventListener("click", () => callbacks.attach(suggestion.path));

    const pin = row.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": suggestion.pinned ? `Unpin ${suggestion.path}` : `Pin ${suggestion.path}` },
    });
    setIcon(pin, suggestion.pinned ? "pin-off" : "pin");
    pin.addEventListener("click", () => callbacks.togglePin(suggestion.path, suggestion.pinned));

    const exclude = row.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": `Exclude ${suggestion.path}` },
    });
    setIcon(exclude, "x");
    exclude.addEventListener("click", () => callbacks.exclude(suggestion.path));
  }
}

export function relevantNoteFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function relevantNotesEmptyText(reason: RelevantNotesPanelState["emptyReason"]): string {
  switch (reason) {
    case "active-note-ignored":
      return "Active note is ignored.";
    case "active-note-missing":
      return "Active note is not loaded.";
    case "no-related-notes":
      return "No related notes found.";
    case "no-active-note":
    case null:
      return "Open a note to see related notes.";
  }
}
