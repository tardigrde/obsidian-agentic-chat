import { MarkdownView, TFile, TFolder, type App } from "obsidian";
import type { ImageContent } from "@earendil-works/pi-ai";
import { isInstructionFilePath } from "../agent/instructions";
import { buildAttachmentSection } from "./attachments";
import { buildActiveNoteSection, MAX_ACTIVE_NOTE_CHARS, type ActiveNoteContextCache } from "./active-note";
import { attachmentDisplayPath, parseVaultAttachmentRef } from "./attachment-ref";
import { FOLDER_PREFIX } from "./autocomplete";
import { isTextContextAttachment, textContextSection, type ContextAttachment } from "./context-attachments";
import { arrayBufferToBase64, imageMimeType, isImagePath } from "./image-attachments";
import { extractNoteSlice } from "./note-slices";

export interface PromptContextOptions {
  app: App;
  attachments: ContextAttachment[];
  activeNotePath: string | null;
  isPathIgnored: (path: string) => boolean;
  activeNoteCache?: ActiveNoteContextCache;
}

export interface ImageAttachmentOptions {
  app: App;
  attachments: ContextAttachment[];
  supportsImages: boolean;
}

/** Build the `<context>` preamble sent before a user prompt. */
export async function buildPromptContext(options: PromptContextOptions): Promise<string> {
  const sections: string[] = [];
  if (options.activeNotePath && !isInstructionFilePath(options.activeNotePath)) {
    sections.push(await loadActiveNoteSection(options, options.activeNotePath));
  }

  for (const entry of options.attachments) {
    if (isTextContextAttachment(entry)) {
      sections.push(textContextSection(entry, entry.sourcePath ? options.isPathIgnored(entry.sourcePath) : false));
    } else if (entry.startsWith(FOLDER_PREFIX)) {
      const listing = folderListing(options, entry.slice(FOLDER_PREFIX.length));
      if (listing !== null) sections.push(listing);
    } else if (isImagePath(entry)) {
      // Images go to the model as multimodal parts, not text context.
      continue;
    } else {
      sections.push(await loadAttachmentSection(options, entry));
    }
  }

  if (sections.length === 0) return "";
  return `<context>\nThe user attached the following from their vault:\n\n${sections.join("\n\n---\n\n")}\n</context>`;
}

/** Encode image attachments as multimodal content parts for the model. */
export async function loadImageAttachments(options: ImageAttachmentOptions): Promise<ImageContent[]> {
  if (!options.supportsImages) return [];
  const images: ImageContent[] = [];
  for (const entry of options.attachments) {
    if (isTextContextAttachment(entry)) continue;
    if (!isImagePath(entry)) continue;
    const file = options.app.vault.getAbstractFileByPath(entry);
    if (!(file instanceof TFile)) continue;
    try {
      const buffer = await options.app.vault.readBinary(file);
      images.push({ type: "image", data: arrayBufferToBase64(buffer), mimeType: imageMimeType(file.extension) });
    } catch {
      // A missing/unreadable image just drops out; the text prompt still sends.
    }
  }
  return images;
}

async function loadAttachmentSection(options: PromptContextOptions, entry: string): Promise<string> {
  const ref = parseVaultAttachmentRef(entry);
  const displayPath = attachmentDisplayPath(ref);
  if (options.isPathIgnored(ref.path)) {
    return buildAttachmentSection({ path: displayPath, full: null, restricted: true });
  }

  const file = options.app.vault.getAbstractFileByPath(ref.path);
  let full: string | null = null;
  if (file instanceof TFile) {
    try {
      full = await options.app.vault.cachedRead(file);
    } catch {
      full = null;
    }
  }
  if (full !== null && ref.fragment) {
    const slice = extractNoteSlice(ref.path, full, ref.fragment);
    if (slice) return buildAttachmentSection({ path: slice.label, full: slice.text });
    return `Note "${displayPath}" is attached by reference (the ${ref.fragment.type} was not found). Use the read tool to open "${ref.path}".`;
  }
  return buildAttachmentSection({ path: displayPath, full });
}

async function loadActiveNoteSection(options: PromptContextOptions, path: string): Promise<string> {
  if (options.isPathIgnored(path)) {
    return buildAttachmentSection({ path, full: null, restricted: true });
  }

  const file = options.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return renderActiveNote(options, { path, full: null, limit: MAX_ACTIVE_NOTE_CHARS });

  let full: string;
  try {
    full = await options.app.vault.cachedRead(file);
  } catch {
    return renderActiveNote(options, { path, full: null, limit: MAX_ACTIVE_NOTE_CHARS });
  }
  const visibleRange = full.length > MAX_ACTIVE_NOTE_CHARS ? visibleEditorRange(options.app, file) : null;
  return renderActiveNote(options, { path, full, visibleRange, limit: MAX_ACTIVE_NOTE_CHARS });
}

function renderActiveNote(
  options: PromptContextOptions,
  content: Parameters<typeof buildActiveNoteSection>[0],
): string {
  return options.activeNoteCache?.render(content) ?? buildActiveNoteSection(content);
}

function folderListing(options: PromptContextOptions, folderPath: string): string | null {
  const folder =
    folderPath === "/" ? options.app.vault.getRoot() : options.app.vault.getAbstractFileByPath(folderPath);
  if (!(folder instanceof TFolder)) return null;
  const listing = folder.children
    .filter((child) => !options.isPathIgnored(child.path))
    .map((child) => (child instanceof TFolder ? `${child.name}/` : child.name))
    .join("\n");
  return `Folder listing for "${folderPath}":\n${listing || "(empty)"}`;
}

/**
 * Best-effort slice of the active editor's visible range: a window of lines
 * around the cursor in the matching MarkdownView. Mobile-safe: public Editor API
 * only, and null when there is no editor open on this file.
 */
export function visibleEditorRange(app: App, file: TFile): string | null {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view || view.file?.path !== file.path || !view.editor) return null;
  const editor = view.editor;
  const total = editor.lineCount();
  if (total === 0) return null;
  const cursor = editor.getCursor();
  const half = 120;
  const from = Math.max(0, cursor.line - half);
  const to = Math.min(total - 1, cursor.line + half);
  const lineText = editor.getLine(to);
  const text = editor.getRange({ line: from, ch: 0 }, { line: to, ch: lineText ? lineText.length : 0 });
  return text.trim() ? text : null;
}
