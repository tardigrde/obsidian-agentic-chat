import { Notice, TFile, TFolder, type App } from "obsidian";
import type { AgentService } from "../agent/agent-service";
import { isInstructionFilePath } from "../agent/instructions";
import {
  type AcItem,
  type AcQuery,
  detectQuery,
  FOLDER_PREFIX,
  type MentionCandidate,
  resolve,
  suggest,
} from "./autocomplete";
import type { AutocompleteMenu } from "./autocomplete-menu";
import {
  type ActiveNoteState,
  autoActiveNotePath,
  effectiveActiveNote as computeEffectiveActiveNote,
} from "./active-note";
import { attachmentBasePath } from "./attachment-ref";
import type { ChatTabWorkingState } from "./chat-tab-state";
import {
  contextAttachmentKey,
  isTextContextAttachment,
  type ContextAttachment,
} from "./context-attachments";
import { renderContextChips, renderPendingQueueChip } from "./context-chip-renderer";
import { parseDroppedVaultPath } from "./drag-drop";
import { isImagePath } from "./image-attachments";
import { PromptEditState } from "./prompt-edit-state";
import { visibleCommands } from "./commands";

/** Minimal shape of Obsidian's internal (undocumented) drag manager. */
interface ObsidianDragManager {
  draggable?: { file?: unknown; files?: unknown[] } | null;
}

export interface ChatComposerDeps {
  app: App;
  service: () => AgentService;
  state: () => ChatTabWorkingState;
  inputEl: () => HTMLTextAreaElement;
  menu: () => AutocompleteMenu;
  chipsEl: () => HTMLElement;
  statusEl: () => HTMLElement;
  activeNotePath: () => string | null;
  setActiveNotePath: (path: string | null) => void;
  renderChips: () => void;
  syncChrome: () => void;
}

/**
 * Owns composer editing, history recall, autocomplete, attachments, drop
 * handling, and the queued prompt. The view owns the DOM nodes; this class
 * owns the state and rules that drive them.
 */
export class ChatComposer {
  private activeQuery: AcQuery | null = null;
  private mentionCache: MentionCandidate[] | null = null;
  private autocompleteTimer: number | null = null;
  private pendingChipPreviewValue: string | null = null;
  private editingEl: HTMLElement | null = null;
  private readonly promptEdit = new PromptEditState();

  constructor(private readonly deps: ChatComposerDeps) {}

  get editIndex(): number | null {
    return this.promptEdit.index;
  }

  get isEditing(): boolean {
    return this.promptEdit.isEditing;
  }

  get pendingChipPreview(): string | null {
    return this.pendingChipPreviewValue;
  }

  /** Drop the cached mention list after the vault's file set changes. */
  invalidateMentionCache(): void {
    this.mentionCache = null;
  }

  // --- autocomplete (slash commands, skills, @-mentions) ---

  /**
   * Debounced recompute for typing/caret events, so a fast typist (or a large
   * vault's mention scan) doesn't re-filter on every keystroke. Picking an item
   * calls {@link updateAutocomplete} directly for an instant reopen.
   */
  scheduleAutocomplete(): void {
    this.cancelAutocomplete();
    this.autocompleteTimer = window.setTimeout(() => {
      this.autocompleteTimer = null;
      this.updateAutocomplete();
    }, 120);
  }

  cancelAutocomplete(): void {
    if (this.autocompleteTimer !== null) {
      window.clearTimeout(this.autocompleteTimer);
      this.autocompleteTimer = null;
    }
  }

  private updateAutocomplete(): void {
    if (this.deps.service().isStreaming()) {
      this.deps.menu().hide();
      return;
    }
    const input = this.deps.inputEl();
    const text = input.value;
    const caret = input.selectionStart ?? text.length;
    const query = detectQuery(text, caret);
    if (!query) {
      this.activeQuery = null;
      this.deps.menu().hide();
      return;
    }
    this.activeQuery = query;
    this.deps.menu().show(
      suggest(query, {
        commands: visibleCommands(),
        skills: this.deps.service().getSkills(),
        files: query.kind === "mention" ? this.mentionCandidates() : [],
      }),
    );
  }

  chooseAutocomplete(item: AcItem): void {
    if (!this.activeQuery) return;
    const input = this.deps.inputEl();
    const result = resolve(input.value, this.activeQuery, item);
    input.value = result.text;
    input.setSelectionRange(result.caret, result.caret);
    input.focus();
    if (result.attach) this.addAttachment(result.attach);
    this.activeQuery = null;
    // Re-evaluate so e.g. completing "/skill " immediately offers the skill list.
    this.updateAutocomplete();
  }

  /** All notes and folders as mention candidates, cached until the vault changes. */
  private mentionCandidates(): MentionCandidate[] {
    if (this.mentionCache) return this.mentionCache;
    const candidates: MentionCandidate[] = [];
    for (const file of this.deps.app.vault.getAllLoadedFiles()) {
      if (file instanceof TFolder) {
        if (file.path && file.path !== "/") candidates.push({ path: file.path, type: "folder" });
      } else if (file instanceof TFile) {
        candidates.push({ path: file.path, type: "file", name: file.basename });
      }
    }
    this.mentionCache = candidates;
    return candidates;
  }

  // --- prompt editing (rewrite a sent user turn) ---

  /** Load a sent prompt back into the composer for rewriting. */
  beginEdit(index: number, displayText: string, el: HTMLElement): void {
    if (this.deps.service().isStreaming()) return;
    const input = this.deps.inputEl();
    // Re-clicking the turn already being edited must not reset the composer and
    // discard the user's in-progress changes.
    const edit = this.promptEdit.begin(index, input.value);
    if (!edit.started) return;
    this.clearEditingHighlight();
    this.editingEl = el;
    el.addClass("is-editing");
    this.setComposerValue(displayText);
    input.focus();
    input.setSelectionRange(displayText.length, displayText.length);
    this.deps.statusEl().setText("Editing — Enter to resend, Esc to cancel");
  }

  /** Cancel an in-progress edit, restoring the draft the user had before editing. */
  cancelEditing(): void {
    this.endEditing(true);
  }

  /** Clear editing state. `restoreDraft` puts back the pre-edit composer draft. */
  endEditing(restoreDraft: boolean): void {
    const edit = this.promptEdit.end(restoreDraft);
    if (!edit.ended) return;
    this.clearEditingHighlight();
    if (edit.draftToRestore !== null) this.setComposerValue(edit.draftToRestore);
    this.deps.statusEl().setText("");
  }

  /** Set the composer text and notify input listeners (autocomplete) of the change. */
  setComposerValue(value: string): void {
    const input = this.deps.inputEl();
    input.value = value;
    input.dispatchEvent(new Event("input"));
  }

  /**
   * Set the composer value WITHOUT dispatching an input event, so history recall
   * doesn't reset its own navigation state. Places the caret at the end and hides
   * the autocomplete menu.
   */
  setComposerValueQuiet(value: string): void {
    const input = this.deps.inputEl();
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    this.deps.menu().hide();
  }

  private clearEditingHighlight(): void {
    this.editingEl?.removeClass("is-editing");
    this.editingEl = null;
  }

  // --- command history (shell-style up/down recall) ---

  /** Record a submitted message, skipping consecutive duplicates, then reset navigation. */
  pushHistory(text: string): void {
    this.deps.state().history.record(text);
  }

  resetHistoryNav(): void {
    this.deps.state().history.resetNavigation();
  }

  /**
   * Cycle the composer through sent-message history. `direction` is -1 (older,
   * ArrowUp) or +1 (newer, ArrowDown). Only acts when the caret is on the edge
   * line in that direction, so arrow keys still move within a multi-line draft.
   * Returns true when it consumed the key.
   */
  recallHistory(direction: -1 | 1): boolean {
    if (this.promptEdit.isEditing) return false;
    const input = this.deps.inputEl();
    const result = this.deps.state().history.recall(direction, {
      value: input.value,
      selectionStart: input.selectionStart,
      selectionEnd: input.selectionEnd,
    });
    if (!result.handled) return false;
    if (result.value !== undefined) this.setComposerValueQuiet(result.value);
    return true;
  }

  // --- attachments + chips ---

  addAttachment(entry: ContextAttachment): void {
    // Image attachments only make sense for a vision-capable model.
    if (typeof entry === "string" && isImagePath(entry) && !this.deps.service().supportsImages()) {
      new Notice("This model can't read images. Switch to a vision model to attach images.");
      return;
    }
    this.pushAttachment(entry);
  }

  /** Dedup-aware push; returns true when the attachment was newly added. The
   * multi-file drop path checks vision support itself (to aggregate the notice)
   * and routes through here, skipping the per-entry guard in addAttachment. */
  pushAttachment(entry: ContextAttachment): boolean {
    const key = contextAttachmentKey(entry);
    const attachments = this.deps.state().attachments;
    if (attachments.some((existing) => contextAttachmentKey(existing) === key)) return false;
    attachments.push(entry);
    this.deps.renderChips();
    return true;
  }

  /**
   * Recompute the auto-attached active note from the focused leaf, honoring suppression.
   * Limited to Markdown notes — the active leaf can be an image/PDF/canvas, which would
   * be read as garbage UTF-8 and injected into the prompt.
   */
  syncActiveNote(): void {
    const state = this.deps.state();
    this.deps.setActiveNotePath(autoActiveNotePath(this.deps.app.workspace.getActiveFile(), {
      suppressed: state.activeNoteSuppressed,
      isIgnored: (path) => this.deps.service().isPathIgnored(path),
    }));
    this.deps.renderChips();
  }

  /** The active note auto-attached this turn, or null (suppressed / none / already explicit). */
  effectiveActiveNote(): string | null {
    const active = computeEffectiveActiveNote(this.activeNoteState());
    return active && isInstructionFilePath(active) ? null : active;
  }

  private activeNoteState(): ActiveNoteState {
    const state = this.deps.state();
    return {
      activePath: this.deps.activeNotePath(),
      suppressed: state.activeNoteSuppressed,
      explicit: state.attachments
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => attachmentBasePath(entry)),
      selectedTextSources: state.attachments
        .filter(isTextContextAttachment)
        .map((entry) => entry.sourcePath)
        .filter((path): path is string => Boolean(path)),
    };
  }

  renderChips(): void {
    const state = this.deps.state();
    renderContextChips(
      this.deps.chipsEl(),
      {
        activeNotePath: this.effectiveActiveNote(),
        attachments: state.attachments,
      },
      {
        removeActiveNote: () => {
          state.activeNoteSuppressed = true;
          this.deps.setActiveNotePath(null);
          this.renderChips();
        },
        removeAttachment: (entry) => {
          const key = contextAttachmentKey(entry);
          state.attachments = state.attachments.filter((a) => contextAttachmentKey(a) !== key);
          this.renderChips();
        },
      },
    );
    if (state.queuedPromptArmed) {
      const text = this.deps.inputEl().value.trim();
      if (text) {
        renderPendingQueueChip(this.deps.chipsEl(), { text }, { cancel: () => this.cancelQueuedPrompt() });
      }
      this.pendingChipPreviewValue = text || null;
    } else {
      this.pendingChipPreviewValue = null;
    }
  }

  // --- drop handling ---

  /**
   * Turn dropped notes/folders into context attachments instead of opening them.
   * Multi-select drops are supported — every dragged entry attaches at once. Only
   * real vault entries are intercepted; otherwise the drop falls through to Obsidian.
   */
  handleDrop(event: DragEvent): void {
    const entries = this.resolveDroppedEntries(event);
    if (!entries.length) return;
    event.preventDefault();
    event.stopPropagation();
    // Count vision-blocked images across the whole batch so we post one aggregated
    // notice instead of one toast per file (the single-entry addAttachment path
    // still self-notifies for non-drop attachers).
    let skippedImages = 0;
    for (const entry of entries) {
      const path = entry instanceof TFolder ? `${FOLDER_PREFIX}${entry.path}` : entry.path;
      if (isImagePath(path) && !this.deps.service().supportsImages()) {
        skippedImages++;
        continue;
      }
      this.pushAttachment(path);
    }
    if (skippedImages > 0) {
      new Notice(
        skippedImages === 1
          ? "This model can't read images. Switch to a vision model to attach images."
          : `${skippedImages} images skipped — this model can't read images. Switch to a vision model.`,
      );
    }
  }

  /**
   * Resolve a drop to the vault files/folders it carries. Obsidian's file-explorer
   * and editor drags no longer put an `obsidian://` URL on the dataTransfer, so we
   * first ask the internal drag manager for the entries being dragged (a single
   * `file` or a multi-select `files` array), then fall back to parsing a path/URL
   * out of the drop payload (external or older drags, single entry only).
   */
  private resolveDroppedEntries(event: DragEvent): Array<TFile | TFolder> {
    const dragManager = (this.deps.app as unknown as { dragManager?: ObsidianDragManager }).dragManager;
    const dragged = dragManager?.draggable;
    const candidates: unknown[] = [];
    if (dragged?.file) candidates.push(dragged.file);
    if (Array.isArray(dragged?.files)) candidates.push(...dragged.files);
    const fromDrag = candidates.filter(
      (entry): entry is TFile | TFolder => entry instanceof TFile || entry instanceof TFolder,
    );
    if (fromDrag.length) return fromDrag;

    const data =
      event.dataTransfer?.getData("text/plain") || event.dataTransfer?.getData("text/uri-list") || "";
    const path = parseDroppedVaultPath(data, this.deps.app.vault.getName());
    if (!path) return [];
    const file = this.deps.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile || file instanceof TFolder ? [file] : [];
  }

  // --- queued prompt ---

  queueComposerPrompt(): void {
    this.deps.state().queuedPromptArmed = true;
    this.deps.statusEl().setText("Queued next.");
    this.deps.renderChips();
    this.deps.syncChrome();
  }

  /** Un-arm a queued prompt, keeping the draft in the composer for editing. */
  cancelQueuedPrompt(): void {
    if (!this.deps.state().queuedPromptArmed) return;
    this.clearQueuedPrompt();
    this.deps.inputEl().focus();
  }

  /** Drop the queued state without moving focus (session changes keep the draft). */
  clearQueuedPrompt(): void {
    if (!this.deps.state().queuedPromptArmed) return;
    this.deps.state().queuedPromptArmed = false;
    this.deps.statusEl().setText("");
    this.deps.renderChips();
    this.deps.syncChrome();
  }
}
