import { App, SuggestModal } from "obsidian";
import { formatContextWindow } from "../llm/models";

export interface BrowsableModel {
  id: string;
  name: string;
  contextLength: number | null;
}

/**
 * Picker over OpenRouter models (already filtered to tool-capable). Uses a plain
 * substring filter so results stay in the alphabetical order they arrive in —
 * a FuzzySuggestModal would reorder matches by fuzzy score.
 */
export class ModelSuggestModal extends SuggestModal<BrowsableModel> {
  constructor(
    app: App,
    private readonly models: BrowsableModel[],
    private readonly onChoose: (model: BrowsableModel) => void,
  ) {
    super(app);
    this.setPlaceholder("Pick an OpenRouter model (tool-calling capable)…");
  }

  getSuggestions(query: string): BrowsableModel[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return this.models;
    return this.models.filter(
      (model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
    );
  }

  renderSuggestion(model: BrowsableModel, el: HTMLElement): void {
    el.setText(itemText(model));
  }

  onChooseSuggestion(model: BrowsableModel): void {
    this.onChoose(model);
  }
}

function itemText(model: BrowsableModel): string {
  const context = formatContextWindow(model.contextLength);
  return context ? `${model.id} · ${context} ctx` : model.id;
}
