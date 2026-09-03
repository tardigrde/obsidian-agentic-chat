import { setIcon } from "obsidian";
import type { AcItem } from "./autocomplete";

/**
 * Floating suggestion list above the composer. Pure DOM + keyboard handling; the
 * candidate computation lives in the testable `autocomplete` engine. Rows use
 * `mousedown` (with `preventDefault`) so picking one never blurs the textarea.
 *
 * The menu is anchored to the input card, not the textarea wrapper: the card
 * has `overflow: hidden` (rounded-corner clipping), so anything positioned
 * inside it is clipped. Instead the menu lives on the composer (no clipping)
 * and is measured against the card on every show/resize.
 */
export class AutocompleteMenu {
  private readonly el: HTMLElement;
  private readonly anchor: () => HTMLElement | null;
  private readonly repositionObserver: ResizeObserver | null;
  private anchorObserved: HTMLElement | null = null;
  private items: AcItem[] = [];
  private rows: HTMLElement[] = [];
  private selected = 0;
  private open = false;

  constructor(
    parent: HTMLElement,
    private readonly onChoose: (item: AcItem) => void,
    getAnchor?: () => HTMLElement | null,
  ) {
    this.el = parent.createDiv({ cls: "agentic-chat-autocomplete" });
    this.anchor = getAnchor ?? (() => parent);
    // Keep clicks on the menu chrome (scrollbar, padding) from blurring the textarea,
    // which would hide the menu before the user can scroll or pick.
    this.el.addEventListener("mousedown", (event) => event.preventDefault());
    this.el.hide();
    // Card height (textarea resize) and composer width (pane resize) move the
    // anchor — re-measure while open so the menu stays glued to the card.
    if (typeof ResizeObserver !== "undefined") {
      this.repositionObserver = new ResizeObserver(() => {
        if (this.open) this.reposition();
      });
      this.repositionObserver.observe(parent);
    } else {
      this.repositionObserver = null;
    }
  }

  /** Disconnect observers and remove the menu element (view teardown). */
  detach(): void {
    this.repositionObserver?.disconnect();
    this.anchorObserved = null;
    this.el.detach();
  }

  /** Track the anchor card so textarea resizes move the menu while open. */
  private observeAnchor(): void {
    const target = this.anchor();
    if (!target || target === this.anchorObserved) return;
    this.anchorObserved = target;
    this.repositionObserver?.observe(target);
  }

  /**
   * Glue the menu to the top of the anchor card. The menu lives on the
   * composer (no `overflow: hidden` there); offsets are measured against the
   * card so pane resizes and textarea resizes both stay correct.
   */
  private reposition(): void {
    const parent = this.el.parentElement;
    const target = this.anchor() ?? parent;
    if (!parent || !target) return;
    if (target.offsetWidth <= 0) return;
    const gap = 8;
    // left + width win over the stylesheet's right:0 (over-constrained
    // absolute positioning ignores right in LTR), so right needs no inline set.
    this.el.style.left = `${target.offsetLeft}px`;
    this.el.style.width = `${target.offsetWidth}px`;
    this.el.style.bottom = `${parent.clientHeight - target.offsetTop + gap}px`;
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
    this.observeAnchor();
    this.reposition();
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
