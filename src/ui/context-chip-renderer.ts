import { setIcon } from "obsidian";
import { FOLDER_PREFIX } from "./autocomplete";
import {
  contextAttachmentLabel,
  isTextContextAttachment,
  type ContextAttachment,
} from "./context-attachments";
import { isImagePath } from "./image-attachments";
import { formatWorkingDirLabel } from "./working-directory-workflow-controller";

export interface ContextChipRenderState {
  workingDirs: readonly string[];
  activeNotePath: string | null;
  attachments: readonly ContextAttachment[];
}

export interface ContextChipCallbacks {
  removeWorkingDir: (dir: string) => void;
  removeActiveNote: () => void;
  removeAttachment: (entry: ContextAttachment) => void;
}

export function renderContextChips(
  parent: HTMLElement,
  state: ContextChipRenderState,
  callbacks: ContextChipCallbacks,
): void {
  parent.empty();
  for (const dir of state.workingDirs) {
    renderScopeChip(parent, dir, () => callbacks.removeWorkingDir(dir));
  }
  if (state.activeNotePath) {
    renderAttachmentChip(parent, state.activeNotePath, true, callbacks.removeActiveNote);
  }
  for (const entry of state.attachments) {
    renderAttachmentChip(parent, entry, false, () => callbacks.removeAttachment(entry));
  }
}

function renderAttachmentChip(
  parent: HTMLElement,
  entry: ContextAttachment,
  active: boolean,
  onRemove: () => void,
): void {
  const isText = isTextContextAttachment(entry);
  const path = typeof entry === "string" ? entry : "";
  const isFolder = path.startsWith(FOLDER_PREFIX);
  const isImage = path ? isImagePath(path) : false;
  const chip = parent.createDiv({ cls: active ? ["agentic-chat-chip", "is-active-note"] : ["agentic-chat-chip"] });
  const icon = chip.createSpan({ cls: "agentic-chat-chip-icon" });
  let iconName: string;
  if (isText) iconName = "text-select";
  else if (isFolder) iconName = "folder";
  else if (isImage) iconName = "image";
  else iconName = "file-text";
  setIcon(icon, iconName);
  chip.createSpan({ text: isFolder ? path.slice(FOLDER_PREFIX.length) : contextAttachmentLabel(entry) });
  if (active) {
    chip.createSpan({ cls: "agentic-chat-chip-tag", text: "active" });
    chip.setAttr("title", "The active note is attached automatically — remove to stop for this session.");
  }
  const remove = chip.createSpan({ cls: "agentic-chat-chip-remove" });
  setIcon(remove, "x");
  remove.addEventListener("click", onRemove);
}

function renderScopeChip(parent: HTMLElement, dir: string, onRemove: () => void): void {
  const chip = parent.createDiv({ cls: ["agentic-chat-chip", "is-scope"] });
  const icon = chip.createSpan({ cls: "agentic-chat-chip-icon" });
  setIcon(icon, "folder-check");
  chip.createSpan({ text: formatWorkingDirLabel(dir) });
  chip.createSpan({ cls: "agentic-chat-chip-tag", text: "scope" });
  chip.setAttr(
    "title",
    "Working directory — the agent auto-runs inside it and asks before touching anything outside. Remove to revoke.",
  );
  const remove = chip.createSpan({ cls: "agentic-chat-chip-remove" });
  setIcon(remove, "x");
  remove.addEventListener("click", onRemove);
}
