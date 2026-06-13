import { App, FuzzySuggestModal } from "obsidian";

export interface BrowsableModel {
  id: string;
  name: string;
  contextLength: number | null;
}

/** Fuzzy picker over OpenRouter models (already filtered to tool-capable). */
export class ModelSuggestModal extends FuzzySuggestModal<BrowsableModel> {
  constructor(
    app: App,
    private readonly models: BrowsableModel[],
    private readonly onChoose: (model: BrowsableModel) => void,
  ) {
    super(app);
    this.setPlaceholder("Pick an OpenRouter model (tool-calling capable)…");
  }

  getItems(): BrowsableModel[] {
    return this.models;
  }

  getItemText(model: BrowsableModel): string {
    const context = model.contextLength ? ` · ${Math.round(model.contextLength / 1000)}k ctx` : "";
    return `${model.id}${context}`;
  }

  onChooseItem(model: BrowsableModel): void {
    this.onChoose(model);
  }
}
