import { setIcon } from "obsidian";
import { acHook } from "./test-hooks";
import {
  fitTabs,
  mostUrgentStatus,
  tabAriaLabel,
  tabDisplayLabel,
  tabTooltip,
  TAB_STATUS_TEXT,
  type TabStatus,
} from "./tab-status";

/** The header nodes the strip renders into (built once by chat-layout). */
export interface TabHeaderElements {
  header: HTMLElement;
  strip: HTMLElement;
  overflow: HTMLButtonElement;
  menu: HTMLElement;
  add: HTMLButtonElement;
}

/** What the strip shows for one tab. */
export interface TabView {
  /** Stable per tab while it is open: a rename follows the tab, not its index. */
  key: string;
  label: string | undefined;
  sessionName: string | undefined;
  status: TabStatus | null;
}

export interface TabStripActions {
  activate(index: number): void;
  close(index: number): void;
  rename(index: number, label: string | undefined): void;
  openHistory(): void;
}

/** Long-press on touch: hold this long without moving to rename a tab. */
export const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;
/** Width kept for the `+N` button when some tabs are hidden. */
const OVERFLOW_RESERVE_PX = 52;

/**
 * Renders the tab header: a `tablist` of number-or-label tabs with status dots,
 * an overflow button with a menu, and inline rename. Every tab stays in the DOM
 * (index order); tabs that do not fit get `is-overflow` and show in the menu.
 */
export class TabStrip {
  private tabs: TabView[] = [];
  private activeIndex = 0;
  private editingIndex: number | null = null;
  /** Ends the open rename (commit or cancel); null when no rename is open. */
  private finishEdit: ((commit: boolean) => void) | null = null;
  private menuOpen = false;
  /** What the strip last drew; a re-render with the same state keeps the nodes. */
  private renderedKey: string | null = null;
  /** Cancels for pending long-press timers; a rebuild drops the old nodes, so it runs them. */
  private readonly longPressCancels = new Set<() => void>();
  private observer: ResizeObserver | null = null;
  private readonly cleanups: Array<() => void> = [];

  constructor(
    private readonly el: TabHeaderElements,
    private readonly actions: TabStripActions,
  ) {
    el.overflow.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleMenu();
    });
    const doc = el.header.ownerDocument;
    const onPointerDown = (event: Event) => {
      if (!this.menuOpen) return;
      const target = event.target as Node | null;
      if (target && (el.menu.contains(target) || el.overflow.contains(target))) return;
      this.closeMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && this.menuOpen) {
        this.closeMenu();
        el.overflow.focus();
      }
    };
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("keydown", onKey);
    this.cleanups.push(() => doc.removeEventListener("pointerdown", onPointerDown, true));
    this.cleanups.push(() => doc.removeEventListener("keydown", onKey));
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.layout());
      this.observer.observe(el.header);
    }
  }

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const cancel of this.longPressCancels) cancel();
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  get isEditing(): boolean {
    return this.editingIndex !== null;
  }

  /** Re-render every tab. A rename in progress is kept until it commits. */
  render(tabs: TabView[], activeIndex: number, canAdd: boolean, maxTabs: number): void {
    const editingKey = this.editingIndex === null ? undefined : this.tabs[this.editingIndex]?.key;
    const sameShape =
      activeIndex === this.activeIndex && tabs.length === this.tabs.length && tabs.every((tab, i) => tab.key === this.tabs[i]?.key);
    this.tabs = tabs;
    this.activeIndex = activeIndex;
    this.el.add.disabled = !canAdd;
    this.el.add.setAttr("aria-disabled", String(!canAdd));
    this.el.add.setAttr("title", canAdd ? "New tab" : `Up to ${maxTabs} tabs. Close one to open another.`);
    if (this.isEditing) {
      // A status or label change waits: the rename re-renders when it ends.
      if (sameShape) return;
      // A tab closed or another tab became active under an open rename: save
      // it first, so it lands on the right tab (by key) and nothing freezes.
      this.finishEdit?.(editingKey !== undefined && tabs.some((tab) => tab.key === editingKey));
    }
    // Background tabs re-render on every stream event. Rebuilding unchanged
    // nodes would drop keyboard focus and lose a click between down and up.
    const key = JSON.stringify([tabs, activeIndex]);
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    const strip = this.el.strip;
    const doc = strip.ownerDocument;
    const focused = Array.from(strip.querySelectorAll<HTMLElement>('[data-ac="tab"]')).indexOf(doc.activeElement as HTMLElement);
    // A rebuild replaces the node a finger may be holding: its lift never
    // arrives, so cancel the long-press here or a rename opens uninvited.
    for (const cancel of this.longPressCancels) cancel();
    strip.empty();
    tabs.forEach((tab, index) => this.renderTab(strip, tab, index));
    if (focused >= 0) strip.querySelectorAll<HTMLElement>('[data-ac="tab"]')[Math.min(focused, tabs.length - 1)]?.focus();
    this.layout();
    if (this.menuOpen) this.renderMenu();
  }

  private renderTab(strip: HTMLElement, tab: TabView, index: number): void {
    const active = index === this.activeIndex;
    const el = acHook(
      strip.createDiv({
        cls: "agentic-chat-tab",
        attr: {
          role: "tab",
          tabindex: active ? "0" : "-1",
          "aria-selected": String(active),
          "aria-label": tabAriaLabel(index, tab.label, tab.status),
          title: tabTooltip(index, tab.sessionName),
          "data-ac-state": tab.status ?? "idle",
        },
      }),
      "tab",
    );
    el.toggleClass("is-active", active);
    el.toggleClass("is-number", !tab.label);
    acHook(el.createSpan({ cls: "agentic-chat-tab-label", text: tabDisplayLabel(index, tab.label) }), "tab-label");
    if (tab.status) {
      el.createSpan({ cls: ["agentic-chat-dot", `is-${tab.status}`], attr: { "aria-hidden": "true" } });
    }
    if (this.tabs.length > 1) {
      const close = acHook(
        el.createSpan({ cls: "agentic-chat-tab-close", attr: { role: "button", tabindex: "-1", "aria-label": `Close tab ${index + 1}` } }),
        "tab-close",
      );
      setIcon(close, "x");
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        this.actions.close(index);
      });
    }
    el.addEventListener("click", () => {
      if (this.editingIndex === index) return;
      this.actions.activate(index);
    });
    el.addEventListener("dblclick", (event) => {
      event.preventDefault();
      this.beginRename(index);
    });
    el.addEventListener("keydown", (event) => this.onTabKey(event, index));
    this.wireLongPress(el, index);
  }

  /** Roving focus: Left/Right/Home/End move and activate; Enter or Space activates. */
  private onTabKey(event: KeyboardEvent, index: number): void {
    if (this.editingIndex === index) return;
    const last = this.tabs.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = index >= last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index <= 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      this.actions.activate(index);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    this.actions.activate(next);
    this.focusTab(next);
  }

  /** Focus a tab after the next render (activation re-renders the strip). */
  private focusTab(index: number): void {
    const focus = () => this.el.strip.querySelectorAll<HTMLElement>('[data-ac="tab"]')[index]?.focus();
    focus();
    window.setTimeout(focus, 0);
  }

  /** Touch: hold 500 ms without moving to rename. A move or lift cancels it. */
  private wireLongPress(el: HTMLElement, index: number): void {
    let timer: number | null = null;
    let start: { x: number; y: number } | null = null;
    const cancel = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      start = null;
      this.longPressCancels.delete(cancel);
    };
    el.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch") return;
      if (timer !== null) window.clearTimeout(timer);
      start = { x: event.clientX, y: event.clientY };
      this.longPressCancels.add(cancel);
      timer = window.setTimeout(() => {
        timer = null;
        this.longPressCancels.delete(cancel);
        this.beginRename(index);
      }, LONG_PRESS_MS);
    });
    el.addEventListener("pointermove", (event) => {
      if (!start) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel();
    });
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointercancel", cancel);
    // A touch long-press also opens the system context menu; the rename wins.
    el.addEventListener("contextmenu", (event) => {
      if (event.pointerType === "touch") event.preventDefault();
    });
  }

  /** Turn the tab's label into an inline input. Enter or blur saves, Esc cancels. */
  beginRename(index: number): void {
    if (this.editingIndex !== null) return;
    const tabEl = this.el.strip.querySelectorAll<HTMLElement>('[data-ac="tab"]')[index];
    const labelEl = tabEl?.querySelector<HTMLElement>(".agentic-chat-tab-label");
    if (!tabEl || !labelEl) return;
    this.closeMenu();
    this.editingIndex = index;
    tabEl.addClass("is-editing");
    tabEl.removeClass("is-overflow");
    const current = this.tabs[index]?.label ?? "";
    const input = tabEl.ownerDocument.createElement("input");
    input.className = "agentic-chat-tab-input";
    input.type = "text";
    input.value = current;
    input.placeholder = `Tab ${index + 1}`;
    input.maxLength = 32;
    input.setAttribute("aria-label", `Name tab ${index + 1}`);
    acHook(input, "tab-input");
    labelEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const key = this.tabs[index]?.key;
    const finish = (commit: boolean) => {
      if (done) return;
      done = true;
      this.finishEdit = null;
      // The tab may have moved (an earlier tab closed): rename it where it is now.
      const now = key === undefined ? -1 : this.tabs.findIndex((tab) => tab.key === key);
      this.editingIndex = null;
      // The input replaced the label: draw the tabs again even if the state is the same.
      this.renderedKey = null;
      const value = input.value.trim();
      if (commit && now !== -1 && value !== current) this.actions.rename(now, value || undefined);
      // Re-render either way so the label (or the number) comes back.
      this.render(this.tabs, this.activeIndex, !this.el.add.disabled, this.tabs.length);
    };
    this.finishEdit = finish;
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        event.preventDefault();
        finish(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("dblclick", (event) => event.stopPropagation());
  }

  /** Hide the tabs that do not fit and update the overflow button. */
  layout(): void {
    const tabEls = Array.from(this.el.strip.querySelectorAll<HTMLElement>('[data-ac="tab"]'));
    for (const tabEl of tabEls) tabEl.removeClass("is-overflow");
    const widths = tabEls.map((tabEl) => tabEl.getBoundingClientRect().width);
    const gap = Number.parseFloat(getComputedStyle(this.el.strip).columnGap) || 0;
    const visible = fitTabs(widths, this.el.strip.clientWidth, this.activeIndex, OVERFLOW_RESERVE_PX, gap);
    tabEls.forEach((tabEl, index) => tabEl.toggleClass("is-overflow", !visible.has(index)));
    const hidden = this.tabs.map((_, index) => index).filter((index) => !visible.has(index));
    this.renderOverflowButton(hidden);
  }

  private hiddenIndexes(): number[] {
    return Array.from(this.el.strip.querySelectorAll<HTMLElement>('[data-ac="tab"]'))
      .map((tabEl, index) => (tabEl.hasClass("is-overflow") ? index : -1))
      .filter((index) => index >= 0);
  }

  private renderOverflowButton(hidden: number[]): void {
    const button = this.el.overflow;
    button.empty();
    const status = mostUrgentStatus(hidden.map((index) => this.tabs[index]?.status ?? null));
    if (hidden.length > 0) {
      button.createSpan({ cls: "agentic-chat-tab-overflow-count", text: `+${hidden.length}` });
      if (status) button.createSpan({ cls: ["agentic-chat-dot", `is-${status}`], attr: { "aria-hidden": "true" } });
      const chevron = button.createSpan({ cls: "agentic-chat-tab-overflow-icon", attr: { "aria-hidden": "true" } });
      setIcon(chevron, "chevron-down");
    } else {
      const more = button.createSpan({ cls: "agentic-chat-tab-overflow-icon", attr: { "aria-hidden": "true" } });
      setIcon(more, "more-horizontal");
    }
    const label =
      hidden.length > 0
        ? `${hidden.length} more tab${hidden.length === 1 ? "" : "s"}${status ? `, ${TAB_STATUS_TEXT[status]}` : ""}`
        : "Tab menu";
    button.setAttr("aria-label", label);
    button.setAttr("title", label);
    button.setAttr("data-ac-state", status ?? "idle");
  }

  private toggleMenu(): void {
    if (this.menuOpen) this.closeMenu();
    else this.openMenu();
  }

  private openMenu(): void {
    this.menuOpen = true;
    this.el.overflow.setAttr("aria-expanded", "true");
    this.renderMenu();
    this.el.menu.show();
    this.el.menu.querySelector<HTMLElement>(".agentic-chat-menu-item")?.focus();
  }

  closeMenu(): void {
    if (!this.menuOpen) return;
    this.menuOpen = false;
    this.el.overflow.setAttr("aria-expanded", "false");
    this.el.menu.hide();
  }

  private renderMenu(): void {
    const menu = this.el.menu;
    menu.empty();
    const hidden = this.hiddenIndexes();
    if (hidden.length > 0) {
      menu.createDiv({ cls: "agentic-chat-menu-label", text: "More tabs" });
      for (const index of hidden) {
        const tab = this.tabs[index];
        const item = this.menuItem(menu, () => this.actions.activate(index));
        item.createSpan({ cls: "agentic-chat-menu-num", text: String(index + 1) });
        item.createSpan({ cls: "agentic-chat-menu-text", text: tab.label || tab.sessionName || "New chat" });
        if (tab.status) item.createSpan({ cls: ["agentic-chat-dot", `is-${tab.status}`], attr: { "aria-hidden": "true" } });
        item.setAttr("aria-label", tabAriaLabel(index, tab.label, tab.status));
      }
      menu.createDiv({ cls: "agentic-chat-menu-sep" });
    }
    // Next tick: the menu click must finish (and focus settle) before the input takes focus.
    this.iconItem(menu, "pencil", "Rename current tab", () => window.setTimeout(() => this.beginRename(this.activeIndex), 0));
    this.iconItem(menu, "history", "Open from history…", () => this.actions.openHistory());
    this.iconItem(menu, "x", "Close current tab", () => this.actions.close(this.activeIndex));
  }

  private menuItem(menu: HTMLElement, onClick: () => void): HTMLButtonElement {
    const item = menu.createEl("button", { cls: "agentic-chat-menu-item", attr: { type: "button", role: "menuitem" } });
    item.addEventListener("click", (event) => {
      event.stopPropagation();
      this.closeMenu();
      onClick();
    });
    return item;
  }

  private iconItem(menu: HTMLElement, icon: string, text: string, onClick: () => void): void {
    const item = this.menuItem(menu, onClick);
    const iconEl = item.createSpan({ cls: "agentic-chat-menu-icon", attr: { "aria-hidden": "true" } });
    setIcon(iconEl, icon);
    item.createSpan({ cls: "agentic-chat-menu-text", text });
  }
}
