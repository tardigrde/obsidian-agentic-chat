import { setIcon } from "obsidian";
import type { AcItem } from "./autocomplete";

/**
 * Floating suggestion list above the composer. Pure DOM + keyboard handling; the
 * candidate computation lives in the testable `autocomplete` engine. Rows use
 * `mousedown` (with `preventDefault`) so picking one never blurs the textarea.
 */
export class AutocompleteMenu {
  private readonly el: HTMLElement;
  private items: AcItem[] = [];
  private rows: HTMLElement[] = [];
  private selected = 0;
  private open = false;

  constructor(
    parent: HTMLElement,
    private readonly onChoose: (item: AcItem) => void,
  ) {
    this.el = parent.createDiv({ cls: "agentic-chat-autocomplete" });
    this.el.hide();
  }

  isOpen(): boolean {
    return this.open;
  }

  show(items: AcItem[]): void {
    if (items.length === 0) {
      this.hide();
      return;
    }
    this.items = items;
    this.selected = 0;
    this.render();
    this.el.show();
    this.open = true;
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.items = [];
    this.rows = [];
    this.el.empty();
    this.el.hide();
  }

  /** Handle a composer keydown. Returns true when the key was consumed by the menu. */
  handleKey(event: KeyboardEvent): boolean {
    if (!this.open) return false;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.move(1);
        return true;
      case "ArrowUp":
        event.preventDefault();
        this.move(-1);
        return true;
      case "Tab":
        event.preventDefault();
        if (event.shiftKey) this.move(-1);
        else this.choose();
        return true;
      case "Enter":
        event.preventDefault();
        this.choose();
        return true;
      case "Escape":
        event.preventDefault();
        this.hide();
        return true;
      default:
        return false;
    }
  }

  private move(delta: number): void {
    if (this.items.length === 0) return;
    this.selected = (this.selected + delta + this.items.length) % this.items.length;
    this.updateSelection();
  }

  private choose(): void {
    const item = this.items[this.selected];
    this.hide();
    if (item) this.onChoose(item);
  }

  private render(): void {
    this.el.empty();
    this.rows = this.items.map((item, index) => {
      const row = this.el.createDiv({ cls: "agentic-chat-autocomplete-item" });
      const icon = row.createSpan({ cls: "agentic-chat-autocomplete-icon" });
      setIcon(icon, item.icon);
      const main = row.createDiv({ cls: "agentic-chat-autocomplete-main" });
      main.createSpan({ cls: "agentic-chat-autocomplete-label", text: item.label });
      if (item.detail) main.createSpan({ cls: "agentic-chat-autocomplete-detail", text: item.detail });
      row.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.selected = index;
        this.choose();
      });
      row.addEventListener("mouseenter", () => {
        this.selected = index;
        this.updateSelection();
      });
      return row;
    });
    this.updateSelection();
  }

  private updateSelection(): void {
    this.rows.forEach((row, index) => row.classList.toggle("is-selected", index === this.selected));
    this.rows[this.selected]?.scrollIntoView({ block: "nearest" });
  }
}
