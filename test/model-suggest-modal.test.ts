import { describe, expect, it, vi } from "vitest";
import { App } from "obsidian";
import { ModelSuggestModal, type BrowsableModel } from "../src/ui/model-suggest-modal";

const MODELS: BrowsableModel[] = [
  { id: "openai/gpt-5", name: "GPT-5", contextLength: 400_000 },
  { id: "anthropic/claude", name: "Claude", contextLength: 200_000 },
  { id: "meta/llama", name: "meta/llama", contextLength: null },
];

function modal(onChoose = vi.fn()): { instance: ModelSuggestModal; onChoose: typeof onChoose } {
  const instance = new ModelSuggestModal(new App(), MODELS, onChoose);
  return { instance, onChoose };
}

describe("ModelSuggestModal", () => {
  it("returns every model for an empty query, preserving order", () => {
    expect(modal().instance.getSuggestions("   ").map((m) => m.id)).toEqual([
      "openai/gpt-5",
      "anthropic/claude",
      "meta/llama",
    ]);
  });

  it("filters by id or friendly name, case-insensitively", () => {
    const { instance } = modal();
    expect(instance.getSuggestions("CLAUDE").map((m) => m.id)).toEqual(["anthropic/claude"]);
    expect(instance.getSuggestions("openai").map((m) => m.id)).toEqual(["openai/gpt-5"]);
    expect(instance.getSuggestions("gpt-5").map((m) => m.id)).toEqual(["openai/gpt-5"]);
    expect(instance.getSuggestions("nomatch")).toEqual([]);
  });

  it("renders a label with the friendly name and context window suffix", () => {
    const { instance } = modal();
    const el = { setText: vi.fn() } as unknown as HTMLElement & { setText: ReturnType<typeof vi.fn> };

    instance.renderSuggestion(MODELS[0], el);
    expect((el as { setText: ReturnType<typeof vi.fn> }).setText).toHaveBeenCalledWith("GPT-5 (openai/gpt-5) · 400k ctx");
  });

  it("omits the name and context suffix when they add nothing", () => {
    const { instance } = modal();
    const el = { setText: vi.fn() } as unknown as HTMLElement & { setText: ReturnType<typeof vi.fn> };

    // name === id and contextLength === null, so the label is just the id.
    instance.renderSuggestion(MODELS[2], el);
    expect((el as { setText: ReturnType<typeof vi.fn> }).setText).toHaveBeenCalledWith("meta/llama");
  });

  it("treats a shift-modified choice as a next-message-only override", () => {
    const { instance, onChoose } = modal();

    instance.onChooseSuggestion(MODELS[1], { shiftKey: true } as KeyboardEvent);
    instance.onChooseSuggestion(MODELS[0], { shiftKey: false } as MouseEvent);

    expect(onChoose).toHaveBeenNthCalledWith(1, MODELS[1], true);
    expect(onChoose).toHaveBeenNthCalledWith(2, MODELS[0], false);
  });
});
