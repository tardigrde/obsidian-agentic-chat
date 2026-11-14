import { setIcon, type App, type Component } from "obsidian";
import type { AcItem } from "./autocomplete";
import { AutocompleteMenu } from "./autocomplete-menu";
import type { ComposerSubmitSource } from "./composer-input";
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
  toggleMode(): void;
  switchModel(): void;
  newSession(): void;
  openHistory(): void;
  isEditing(): boolean;
  reconcileQueuedInput(value: string, event: UIEvent): void;
}

export interface ChatLayoutDeps {
  app: App;
  component: Component;
  contentEl: HTMLElement;
  callbacks: ChatLayoutCallbacks;
  registerDomEvent: (el: HTMLElement, type: keyof HTMLElementEventMap, handler: (event: Event) => void) => void;
}

export interface ChatLayoutElements {
  messagesEl: HTMLElement;
  transcript: TranscriptView;
  tabsEl: HTMLElement;
  chipsEl: HTMLElement;
  fieldEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  modeToggleEl: HTMLElement;
  menu: AutocompleteMenu;
  sendButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  statusEl: HTMLElement;
  modelPillEl: HTMLElement;
  effortKnobEl: HTMLElement;
  usageEl: HTMLElement;
  contextBarEl: HTMLProgressElement;
  contextPercentEl: HTMLElement;
  workingEl: HTMLElement;
}

/** Build the chat DOM once and wire the composer, tabs, and toolbar to callbacks. */
export function buildLayout(deps: ChatLayoutDeps): ChatLayoutElements {
  const { callbacks } = deps;
  const root = deps.contentEl;
  root.empty();
  root.addClass("agentic-chat-view");

  const messagesEl = root.createDiv({ cls: "agentic-chat-messages" });
  const transcript = new TranscriptView(messagesEl, {
    app: deps.app,
    component: deps.component,
    renderEmptyState: () => callbacks.renderEmptyState(),
    beginEdit: (index, text, el) => callbacks.beginEdit(index, text, el),
    retryLast: () => callbacks.retryLast(),
    abortSubagentChild: (id) => callbacks.abortSubagentChild(id),
  });
  deps.registerDomEvent(messagesEl, "wheel", () => transcript.markUserScrollIntent());
  deps.registerDomEvent(messagesEl, "touchmove", () => transcript.markUserScrollIntent());
  deps.registerDomEvent(messagesEl, "pointerdown", () => transcript.markUserScrollIntent());
  deps.registerDomEvent(messagesEl, "keydown", () => transcript.markUserScrollIntent());
  deps.registerDomEvent(messagesEl, "scroll", () => transcript.updateScrollPinning());

  const composer = root.createDiv({ cls: "agentic-chat-composer" });

  // Nav row above the input card: tab pills on the left (switch between up to
  // MAX_TABS independent sessions), header actions on the right (C4 / design ref).
  const tabsRow = composer.createDiv({ cls: "agentic-chat-tabs-row" });
  const tabsEl = tabsRow.createDiv({ cls: "agentic-chat-tabs", attr: { role: "tablist" } });
  const headerActions = tabsRow.createDiv({ cls: "agentic-chat-tab-actions" });
  const newChatButton = headerActions.createEl("button", {
    cls: "clickable-icon",
    attr: { "aria-label": "New chat" },
  });
  setIcon(newChatButton, "square-pen");
  newChatButton.addEventListener("click", () => callbacks.newSession());
  const historyButton = headerActions.createEl("button", {
    cls: "clickable-icon",
    attr: { "aria-label": "Conversation history" },
  });
  setIcon(historyButton, "history");
  historyButton.addEventListener("click", () => callbacks.openHistory());

  // The single bordered input card: context row (chips) + textarea + bottom toolbar
  // all live *inside* one rectangle, instead of stacked around a bordered textarea.
  const fieldEl = composer.createDiv({ cls: "agentic-chat-field" });
  const chipsEl = fieldEl.createDiv({ cls: "agentic-chat-chips" });

  const inputWrap = fieldEl.createDiv({ cls: "agentic-chat-input-wrap" });
  const inputEl = inputWrap.createEl("textarea", {
    cls: "agentic-chat-input",
    attr: { rows: "3", placeholder: "Ask about your vault — / for commands, @ to attach a note… (Enter to send)" },
  });
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
  });
  inputEl.addEventListener("click", () => callbacks.scheduleAutocomplete());
  inputEl.addEventListener("keyup", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) callbacks.scheduleAutocomplete();
  });
  inputEl.addEventListener("blur", () => {
    callbacks.cancelAutocomplete();
    menu.hide();
  });

  // Bottom toolbar (in-card): model+effort pill · context on the left; the
  // Safe ↔ YOLO segmented toggle on the right — design ref.
  const toolbar = fieldEl.createDiv({ cls: "agentic-chat-toolbar" });
  const toolbarLeft = toolbar.createDiv({ cls: "agentic-chat-toolbar-left" });

  // Model + reasoning effort share ONE two-sided pill: model on the left, the
  // effort level value on the right (no "Effort" label — the value is enough).
  const modelGroup = toolbarLeft.createDiv({ cls: "agentic-chat-model" });
  const modelPillEl = modelGroup.createDiv({
    cls: "agentic-chat-model-pill",
    attr: { "aria-label": "Switch model" },
  });
  modelPillEl.addEventListener("click", () => callbacks.switchModel());
  modelGroup.createSpan({ cls: "agentic-chat-model-divider", attr: { "aria-hidden": "true" } });

  // Effort knob: click cycles the persisted reasoning level.
  const effortKnobEl = modelGroup.createDiv({
    cls: "agentic-chat-effort",
    attr: { role: "button", tabindex: "0" },
  });
  effortKnobEl.addEventListener("click", () => callbacks.cycleEffort());
  effortKnobEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      callbacks.cycleEffort();
    }
  });

  const contextBarEl = toolbarLeft.createEl("progress", {
    cls: "agentic-chat-ctx-bar",
    attr: { "aria-label": "Context window used", max: "100", value: "0" },
  });
  const contextPercentEl = toolbarLeft.createSpan({ cls: "agentic-chat-ctx-percent" });
  contextBarEl.hide();
  contextPercentEl.hide();

  const toolbarRight = toolbar.createDiv({ cls: "agentic-chat-toolbar-right" });

  // Single Safe ↔ YOLO permission toggle as a segmented pill (beautifului
  // Prompt Bar pattern); the ask/plan/agent dropdown is retired.
  const modeToggleEl = toolbarRight.createDiv({
    cls: "agentic-chat-mode-toggle",
    attr: { role: "switch", tabindex: "0", "aria-label": "Permission mode: Safe", "aria-checked": "false" },
  });
  modeToggleEl.createSpan({ cls: "agentic-chat-mode-seg", text: "Safe" });
  modeToggleEl.createSpan({ cls: "agentic-chat-mode-seg", text: "YOLO" });
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

  const workingEl = toolbarRight.createDiv({ cls: "agentic-chat-working", attr: { "aria-hidden": "true" } });
  workingEl.hide();
  const statusEl = toolbarRight.createDiv({ cls: "agentic-chat-status" });
  const stopButton = toolbarRight.createEl("button", { cls: ["agentic-chat-stop", "mod-warning"], text: "Stop" });
  stopButton.hide();
  stopButton.addEventListener("click", () => callbacks.stopActiveTurn());
  const sendButton = toolbarRight.createEl("button", { cls: ["agentic-chat-send", "mod-cta"], text: "Send" });
  sendButton.addEventListener("click", () => callbacks.submit("button"));

  // Token/cost readout on its own muted line; hidden until there's usage.
  const usageEl = composer.createDiv({ cls: "agentic-chat-usage" });

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
    tabsEl,
    chipsEl,
    fieldEl,
    inputEl,
    modeToggleEl,
    menu,
    sendButton,
    stopButton,
    statusEl,
    modelPillEl,
    effortKnobEl,
    usageEl,
    contextBarEl,
    contextPercentEl,
    workingEl,
  };
}
