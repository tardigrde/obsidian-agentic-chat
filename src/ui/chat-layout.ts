import { setIcon, type App, type Component } from "obsidian";
import type { AcItem } from "./autocomplete";
import { AutocompleteMenu } from "./autocomplete-menu";
import type { ComposerSubmitSource } from "./composer-input";
import { wireContextBreakdownPanel } from "./context-breakdown-panel";
import type { TabHeaderElements } from "./tab-strip";
import { acHook } from "./test-hooks";
import { TranscriptView } from "./transcript-view";

export interface ChatLayoutCallbacks {
  renderEmptyState(): void;
  beginEdit(index: number, text: string, el: HTMLElement): void;
  retryLast(): void;
  abortSubagentChild(id: string): void;
  chooseAutocomplete(item: AcItem): void;
  submit(source: ComposerSubmitSource): void;
  stopActiveTurn(): void;
  cancelEditing(): void;
  recallHistory(direction: -1 | 1): boolean;
  resetHistoryNav(): void;
  scheduleAutocomplete(): void;
  cancelAutocomplete(): void;
  handleDrop(event: DragEvent): void;
  cycleEffort(): void;
  /** Open the @ note picker in the composer. */
  attach(): void;
  toggleMode(): void;
  switchModel(): void;
  addTab(): void;
  openHistory(): void;
  isEditing(): boolean;
  /** Whether the active tab has a turn in flight. */
  isStreaming(): boolean;
  reconcileQueuedInput(value: string, event: UIEvent): void;
}

export interface ChatLayoutDeps {
  app: App;
  component: Component;
  contentEl: HTMLElement;
  callbacks: ChatLayoutCallbacks;
  registerDomEvent: (el: HTMLElement, type: keyof HTMLElementEventMap, handler: (event: Event) => void) => void;
  /** Run `cleanup` when the view closes. */
  register: (cleanup: () => void) => void;
}

export interface ChatLayoutElements {
  messagesEl: HTMLElement;
  transcript: TranscriptView;
  tabHeader: TabHeaderElements;
  chipsEl: HTMLElement;
  fieldEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  modeToggleEl: HTMLElement;
  modeLabelEl: HTMLElement;
  menu: AutocompleteMenu;
  sendButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  statusEl: HTMLElement;
  modelPillEl: HTMLElement;
  effortKnobEl: HTMLElement;
  contextEl: HTMLElement;
  contextRingEl: SVGCircleElement;
  contextPercentEl: HTMLElement;
  workingEl: HTMLElement;
}

export const COMPOSER_PLACEHOLDER = "Ask about your vault…";
/** Radius and circumference of the context ring's value arc (viewBox 20). */
export const CONTEXT_RING_RADIUS = 7;
export const CONTEXT_RING_LENGTH = 2 * Math.PI * CONTEXT_RING_RADIUS;
/** The textarea grows with its text up to this many lines, then scrolls. */
const COMPOSER_MAX_LINES = 8;

/** Grow the textarea to fit its text, from one line up to COMPOSER_MAX_LINES. */
export function autoGrow(inputEl: HTMLTextAreaElement): void {
  const view = inputEl.ownerDocument?.defaultView;
  if (!view) return;
  const style = view.getComputedStyle(inputEl);
  const line = Number.parseFloat(style.lineHeight) || 20;
  const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
  inputEl.setCssProps({ "--ac-input-h": "auto" });
  const max = line * COMPOSER_MAX_LINES + padding;
  inputEl.setCssProps({
    "--ac-input-h": `${Math.min(inputEl.scrollHeight, max)}px`,
    "--ac-input-overflow": inputEl.scrollHeight > max ? "auto" : "hidden",
  });
}

/** Build the chat DOM once and wire the composer, tabs, and toolbar to callbacks. */
export function buildLayout(deps: ChatLayoutDeps): ChatLayoutElements {
  const { callbacks } = deps;
  const root = deps.contentEl;
  root.empty();
  root.addClass("agentic-chat-view");
  acHook(root, "view");

  // Header row: tabs (number or label), the overflow menu, new tab, history.
  const header = acHook(root.createDiv({ cls: "agentic-chat-header" }), "header");
  const tabsEl = acHook(
    header.createDiv({ cls: "agentic-chat-tabs", attr: { role: "tablist", "aria-label": "Chat tabs" } }),
    "tab-strip",
  );
  const overflowButton = acHook(
    header.createEl("button", {
      cls: ["clickable-icon", "agentic-chat-tab-overflow"],
      attr: { type: "button", "aria-haspopup": "menu", "aria-expanded": "false" },
    }),
    "tab-overflow",
  );
  const headerActions = header.createDiv({ cls: "agentic-chat-header-actions" });
  const addTabButton = acHook(
    headerActions.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "New tab" } }),
    "tab-add",
  );
  setIcon(addTabButton, "plus");
  addTabButton.addEventListener("click", () => callbacks.addTab());
  const historyButton = acHook(
    headerActions.createEl("button", { cls: "clickable-icon", attr: { type: "button", "aria-label": "Conversation history" } }),
    "history",
  );
  setIcon(historyButton, "history");
  historyButton.addEventListener("click", () => callbacks.openHistory());
  const tabMenu = acHook(header.createDiv({ cls: "agentic-chat-tab-menu", attr: { role: "menu" } }), "tab-menu");
  tabMenu.hide();
  const tabHeader: TabHeaderElements = { header, strip: tabsEl, overflow: overflowButton, menu: tabMenu, add: addTabButton };

  const messagesEl = acHook(root.createDiv({ cls: "agentic-chat-messages" }), "messages");
  const transcript = new TranscriptView(messagesEl, {
    app: deps.app,
    component: deps.component,
    renderEmptyState: () => callbacks.renderEmptyState(),
    beginEdit: (index, text, el) => callbacks.beginEdit(index, text, el),
    retryLast: () => callbacks.retryLast(),
    abortSubagentChild: (id) => callbacks.abortSubagentChild(id),
    isStreaming: () => callbacks.isStreaming(),
  });
  deps.registerDomEvent(messagesEl, "wheel", () => transcript.markUserScrollIntent());
  deps.registerDomEvent(messagesEl, "touchmove", () => transcript.markUserScrollIntent());
  deps.registerDomEvent(messagesEl, "pointerdown", () => transcript.markUserScrollIntent());
  deps.registerDomEvent(messagesEl, "keydown", () => transcript.markUserScrollIntent());
  deps.registerDomEvent(messagesEl, "scroll", () => transcript.updateScrollPinning());

  const composer = acHook(root.createDiv({ cls: "agentic-chat-composer" }), "composer");

  // Status line above the card: shows only while it has news (a spinner while
  // the agent works, or a one-line message such as "Restored your draft").
  const statusLineEl = composer.createDiv({ cls: "agentic-chat-status-line", attr: { "aria-live": "polite" } });
  const workingEl = statusLineEl.createSpan({ cls: "agentic-chat-working", attr: { "aria-hidden": "true" } });
  workingEl.hide();
  const statusEl = acHook(statusLineEl.createSpan({ cls: "agentic-chat-status" }), "status");
  // "Working…" as real text in the live region (CSS content is not reliably
  // announced). CSS shows it only while running and the status is empty.
  statusLineEl.createSpan({ cls: "agentic-chat-working-text" });

  // The composer card: chips row, an auto-growing textarea, and the toolbar.
  const fieldEl = acHook(composer.createDiv({ cls: "agentic-chat-field" }), "composer-card");
  const chipsEl = acHook(fieldEl.createDiv({ cls: "agentic-chat-chips" }), "chips");

  const inputWrap = fieldEl.createDiv({ cls: "agentic-chat-input-wrap" });
  const inputEl = inputWrap.createEl("textarea", {
    cls: "agentic-chat-input",
    attr: { rows: "1", placeholder: COMPOSER_PLACEHOLDER, "aria-label": "Message" },
  });
  acHook(inputEl, "composer-input");
  const menu = new AutocompleteMenu(
    composer,
    (item) => callbacks.chooseAutocomplete(item),
    () => fieldEl,
  );
  inputEl.addEventListener("keydown", (event) => {
    if (menu.handleKey(event)) return;
    if (event.key === "Escape" && callbacks.isEditing()) {
      event.preventDefault();
      callbacks.cancelEditing();
      return;
    }
    if (event.key === "ArrowUp" && callbacks.recallHistory(-1)) {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" && callbacks.recallHistory(1)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      callbacks.submit("enter");
    }
  });
  // Real user typing both refreshes autocomplete and abandons history navigation.
  // Programmatic value changes (recall) set `.value` directly without an input event.
  inputEl.addEventListener("input", (event) => {
    callbacks.resetHistoryNav();
    // Composition (IME) inputs may briefly leave the value empty; don't drop a
    // queued prompt mid-composition — the trailing non-composing input event
    // reconciles the state. The listener type is Event, but an `input` event
    // is an InputEvent; use Obsidian's cross-window instanceOf() check.
    const inputEvent = event as UIEvent;
    callbacks.reconcileQueuedInput(inputEl.value, inputEvent);
    callbacks.scheduleAutocomplete();
    autoGrow(inputEl);
  });
  inputEl.addEventListener("click", () => callbacks.scheduleAutocomplete());
  inputEl.addEventListener("keyup", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) callbacks.scheduleAutocomplete();
  });
  inputEl.addEventListener("blur", () => {
    callbacks.cancelAutocomplete();
    menu.hide();
  });

  // Toolbar, left to right: attach, model · effort, spacer, context ring,
  // Safe/YOLO, send/stop.
  const toolbar = fieldEl.createDiv({ cls: "agentic-chat-toolbar" });

  const attachButton = toolbar.createEl("button", {
    cls: ["clickable-icon", "agentic-chat-attach"],
    attr: { type: "button", "aria-label": "Attach a note (@)" },
  });
  setIcon(attachButton, "paperclip");
  attachButton.addEventListener("click", () => callbacks.attach());

  // Model and reasoning effort share one pill: the model name opens the model
  // picker; the muted effort value cycles the level (Alt+click on the pill too).
  const modelGroup = toolbar.createDiv({ cls: "agentic-chat-model" });
  const modelPillEl = modelGroup.createDiv({
    cls: "agentic-chat-model-pill",
    attr: { role: "button", tabindex: "0", "aria-label": "Switch model" },
  });
  acHook(modelPillEl, "model-pill");
  modelPillEl.addEventListener("click", (event) => {
    if (event.altKey) callbacks.cycleEffort();
    else callbacks.switchModel();
  });
  modelPillEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      callbacks.switchModel();
    }
  });
  modelGroup.createSpan({ cls: "agentic-chat-model-divider", text: "·", attr: { "aria-hidden": "true" } });

  const effortKnobEl = modelGroup.createDiv({
    cls: "agentic-chat-effort",
    attr: { role: "button", tabindex: "0" },
  });
  acHook(effortKnobEl, "effort");
  effortKnobEl.addEventListener("click", () => callbacks.cycleEffort());
  effortKnobEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      callbacks.cycleEffort();
    }
  });

  toolbar.createSpan({ cls: "agentic-chat-toolbar-spacer" });

  // Context ring: % of the model's window the next request uses. Shown once
  // usage is known. The breakdown is the hover tooltip on desktop, and a tap
  // (or Enter) opens it as a panel above the card, for touch.
  const contextEl = acHook(toolbar.createDiv({ cls: "agentic-chat-ctx", attr: { "aria-label": "Context window used" } }), "context");
  const ring = contextEl.createSvg("svg", { cls: "agentic-chat-ctx-ring", attr: { viewBox: "0 0 20 20", "aria-hidden": "true" } });
  ring.createSvg("circle", { cls: "agentic-chat-ctx-track", attr: { cx: "10", cy: "10", r: String(CONTEXT_RING_RADIUS) } });
  const contextRingEl = ring.createSvg("circle", {
    cls: "agentic-chat-ctx-value",
    attr: {
      cx: "10",
      cy: "10",
      r: String(CONTEXT_RING_RADIUS),
      "stroke-dasharray": String(CONTEXT_RING_LENGTH),
      "stroke-dashoffset": String(CONTEXT_RING_LENGTH),
    },
  });
  const contextPercentEl = contextEl.createSpan({ cls: "agentic-chat-ctx-percent" });
  contextEl.hide();
  deps.register(wireContextBreakdownPanel(contextEl, composer));

  // Safe / YOLO: one shield button. Orange while YOLO; icon only on phones.
  const modeToggleEl = toolbar.createDiv({
    cls: "agentic-chat-mode-toggle",
    attr: { role: "switch", tabindex: "0", "aria-label": "Permission mode: Safe", "aria-checked": "false" },
  });
  acHook(modeToggleEl, "mode-toggle");
  const modeIcon = modeToggleEl.createSpan({ cls: "agentic-chat-mode-icon", attr: { "aria-hidden": "true" } });
  setIcon(modeIcon, "shield");
  const modeLabelEl = modeToggleEl.createSpan({ cls: "agentic-chat-mode-label", text: "Safe" });
  modeToggleEl.setAttr(
    "title",
    "Safe: ask before every edit and action. YOLO: run without asking (for trusted vaults).",
  );
  const toggleMode = () => callbacks.toggleMode();
  modeToggleEl.addEventListener("click", toggleMode);
  modeToggleEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleMode();
    }
  });

  // Send / stop: round buttons. Stop shows while a turn runs; send then queues.
  const stopButton = toolbar.createEl("button", {
    cls: ["agentic-chat-stop", "agentic-chat-round"],
    attr: { type: "button", "aria-label": "Stop" },
  });
  acHook(stopButton, "stop");
  setIcon(stopButton, "square");
  stopButton.hide();
  stopButton.addEventListener("click", () => callbacks.stopActiveTurn());
  const sendButton = toolbar.createEl("button", {
    cls: ["agentic-chat-send", "agentic-chat-round", "mod-cta"],
    attr: { type: "button", "aria-label": "Send" },
  });
  acHook(sendButton, "send");
  sendButton.addEventListener("click", () => callbacks.submit("button"));

  // Dragging a note onto the composer should attach it as context, not open it.
  deps.registerDomEvent(composer, "dragover", (event) => {
    event.preventDefault();
    const dragEvent = event as DragEvent;
    if (dragEvent.dataTransfer) dragEvent.dataTransfer.dropEffect = "copy";
  });
  deps.registerDomEvent(composer, "drop", (event) => callbacks.handleDrop(event as DragEvent));

  return {
    messagesEl,
    transcript,
    tabHeader,
    chipsEl,
    fieldEl,
    inputEl,
    modeToggleEl,
    modeLabelEl,
    menu,
    sendButton,
    stopButton,
    statusEl,
    modelPillEl,
    effortKnobEl,
    contextEl,
    contextRingEl,
    contextPercentEl,
    workingEl,
  };
}
