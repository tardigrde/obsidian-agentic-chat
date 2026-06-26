import { describe, expect, it } from "vitest";
import { PromptEditState } from "../src/ui/prompt-edit-state";

describe("PromptEditState", () => {
  it("starts editing a prompt and restores the original draft on cancel", () => {
    const state = new PromptEditState();

    expect(state.begin(2, "draft before edit")).toEqual({ started: true, index: 2 });
    expect(state.index).toBe(2);
    expect(state.isEditing).toBe(true);
    expect(state.end(true)).toEqual({ ended: true, draftToRestore: "draft before edit" });
    expect(state.index).toBeNull();
    expect(state.isEditing).toBe(false);
  });

  it("does not restart when the same prompt is clicked again", () => {
    const state = new PromptEditState();

    expect(state.begin(1, "original draft")).toEqual({ started: true, index: 1 });
    expect(state.begin(1, "edited composer contents")).toEqual({ started: false, index: 1 });
    expect(state.end(true).draftToRestore).toBe("original draft");
  });

  it("keeps the first pre-edit draft when switching to another prompt", () => {
    const state = new PromptEditState();

    state.begin(1, "original draft");
    expect(state.begin(3, "first edited prompt")).toEqual({ started: true, index: 3 });

    expect(state.index).toBe(3);
    expect(state.end(true).draftToRestore).toBe("original draft");
  });

  it("clears edit state without restoring on submit", () => {
    const state = new PromptEditState();

    state.begin(4, "draft");

    expect(state.end(false)).toEqual({ ended: true, draftToRestore: null });
    expect(state.end(true)).toEqual({ ended: false, draftToRestore: null });
  });
});
