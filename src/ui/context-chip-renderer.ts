import { setIcon } from "obsidian";
import { FOLDER_PREFIX } from "./autocomplete";
import {
  contextAttachmentLabel,
  isTextContextAttachment,
  type ContextAttachment,
} from "./context-attachments";
import { truncateText } from "./format";
import { isImagePath } from "./image-attachments";
import { acHook } from "./test-hooks";

export interface ContextChipRenderState {
  /** A focused note that is private: a lock chip, nothing sent (U4 #11). */
  privateNotePath?: string | null;
  attachments: readonly ContextAttachment[];
}

export interface ContextChipCallbacks {
  removeAttachment: (entry: ContextAttachment) => void;
}

export function renderContextChips(
  parent: HTMLElement,
  state: ContextChipRenderState,
  callbacks: ContextChipCallbacks,
): void {
  parent.empty();
  if (state.privateNotePath) {
    renderPrivateNoteChip(parent, state.privateNotePath);
  }
  for (const entry of state.attachments) {
    renderAttachmentChip(parent, entry, () => callbacks.removeAttachment(entry));
  }
}

function renderAttachmentChip(
  parent: HTMLElement,
  entry: ContextAttachment,
  onRemove: () => void,
): void {
  const isText = isTextContextAttachment(entry);
  const path = typeof entry === "string" ? entry : "";
  const isFolder = path.startsWith(FOLDER_PREFIX);
  const isImage = path ? isImagePath(path) : false;
  const chip = parent.createDiv({ cls: "agentic-chat-chip" });
  const icon = chip.createSpan({ cls: "agentic-chat-chip-icon" });
  let iconName: string;
  if (isText) iconName = "text-select";
  else if (isFolder) iconName = "folder";
  else if (isImage) iconName = "image";
  else iconName = "file-text";
  setIcon(icon, iconName);
  chip.createSpan({
    cls: "agentic-chat-chip-label",
    text: isFolder ? path.slice(FOLDER_PREFIX.length) : contextAttachmentLabel(entry),
  });
  const remove = chip.createSpan({ cls: "agentic-chat-chip-remove" });
  setIcon(remove, "x");
  remove.addEventListener("click", onRemove);
}

/** The focused note is private: the agent gets nothing from it. */
function renderPrivateNoteChip(parent: HTMLElement, path: string): void {
  const chip = acHook(parent.createDiv({ cls: ["agentic-chat-chip", "is-private"] }), "private-chip");
  const icon = chip.createSpan({ cls: "agentic-chat-chip-icon" });
  setIcon(icon, "lock");
  chip.createSpan({ cls: "agentic-chat-chip-label", text: contextAttachmentLabel(path) });
  chip.createSpan({ cls: "agentic-chat-chip-tag", text: "🔒 private, not sent" });
  chip.setAttr("title", "This note matches your private rules (Settings, Ignored files). Nothing from it goes to the model.");
}

/** A prompt queued while the agent is busy; preview + cancel affordance. */
export function renderPendingQueueChip(
  parent: HTMLElement,
  state: { text: string },
  callbacks: { cancel: () => void },
): void {
  const chip = parent.createDiv({ cls: ["agentic-chat-chip", "is-pending"] });
  const icon = chip.createSpan({ cls: "agentic-chat-chip-icon" });
  setIcon(icon, "timer");
  chip.createSpan({ cls: "agentic-chat-chip-tag", text: "queued" });
  chip.createSpan({ cls: "agentic-chat-chip-text", text: truncateText(state.text, 80) });
  chip.setAttr(
    "title",
    "Sends when the agent finishes. Remove to cancel — the draft stays in the composer.",
  );
  const remove = chip.createSpan({
    cls: "agentic-chat-chip-remove",
    attr: { role: "button", tabindex: "0", "aria-label": "Cancel queued prompt" },
  });
  setIcon(remove, "x");
  remove.addEventListener("click", callbacks.cancel);
  remove.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    callbacks.cancel();
  });
}
