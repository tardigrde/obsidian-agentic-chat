export interface BeginPromptEditResult {
  started: boolean;
  index: number | null;
}

export interface EndPromptEditResult {
  ended: boolean;
  draftToRestore: string | null;
}

/**
 * Pure state machine for rewriting a prior user prompt. ChatView owns the DOM
 * effects; this class owns which turn is being edited and what draft Esc restores.
 */
export class PromptEditState {
  private activeIndex: number | null = null;
  private draftBeforeEdit: string | null = null;

  get index(): number | null {
    return this.activeIndex;
  }

  get isEditing(): boolean {
    return this.activeIndex !== null;
  }

  begin(index: number, currentDraft: string): BeginPromptEditResult {
    if (this.activeIndex === index) return { started: false, index: this.activeIndex };
    if (this.activeIndex === null) this.draftBeforeEdit = currentDraft;
    this.activeIndex = index;
    return { started: true, index: this.activeIndex };
  }

  end(restoreDraft: boolean): EndPromptEditResult {
    const wasEditing = this.activeIndex !== null;
    const draft = this.draftBeforeEdit;
    this.activeIndex = null;
    this.draftBeforeEdit = null;
    return {
      ended: wasEditing,
      draftToRestore: wasEditing && restoreDraft ? draft : null,
    };
  }
}
