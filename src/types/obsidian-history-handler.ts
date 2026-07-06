import "obsidian";

declare module "obsidian" {
  // Obsidian 1.13.1 declares these classes as HistoryHandler implementers but
  // omits the required method from the class declarations.
  interface Menu {
    onHistoryBack(): void;
  }

  interface Modal {
    onHistoryBack(): void;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- T is part of the PopoverSuggest generic surface augmented here; not referenced on this line.
  interface PopoverSuggest<T> {
    onHistoryBack(): void;
  }
}
