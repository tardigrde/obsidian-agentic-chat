import {
  ItemView,
  Notice,
  TFile,
  TFolder,
  type WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type AgenticChatPlugin from "../main";
import type { AgentService } from "../agent/agent-service";
import type { AskUserRequest } from "../tools/ask-user-tool";
import type { ToolApprovalRequest, UserApprovalChoice } from "../agent/tool-call-controller";
import { applyRememberedApprovalChoice } from "../agent/approval-memory";
import { ApprovalModal } from "./approval-modal";
import { VIEW_TYPE_AGENT_CHAT } from "../constants";
import { errorMessage } from "../utils/errors";
import { Notifier } from "./notifications";
import { type AcItem, FOLDER_PREFIX } from "./autocomplete";
import { AutocompleteMenu } from "./autocomplete-menu";
import type { ComposerSubmitSource } from "./composer-input";
import {
  resetChatTabState,
  type ChatTabWorkingState,
} from "./chat-tab-state";
import { ChatTabs, type ChatTab } from "./chat-tabs";
import { ChatComposer } from "./composer-controller";
import { ChatChrome } from "./chat-chrome";
import { ChatTurn } from "./chat-turn";
import { ChatActions } from "./chat-actions";
import { buildLayout as buildChatLayout } from "./chat-layout";
import {
  createTextContextAttachment,
  type ContextAttachment,
} from "./context-attachments";
import {
  type AgentMode,
  resolveModeTransition,
  validateModeTransition,
} from "../agent/modes";
import type { OutputStyle } from "../agent/output-styles";
import { SemanticIndexWorkflowController } from "./semantic-index-workflow-controller";
import { SessionActivationCoordinator, type SessionUiResetOptions } from "./session-activation-coordinator";
import {
  renderActionPanel,
  renderErrorPanel,
  renderInfoPanel,
} from "./info-panel-renderer";
import type { ActionRow } from "./workflow-renderer";
import { TranscriptView } from "./transcript-view";
import type { SlashContext } from "./slash/context";
import { persistEffortLevel } from "./slash/model";

export { VIEW_TYPE_AGENT_CHAT };

export class ChatView extends ItemView {
  private chatTabsOwner?: ChatTabs;
  private composerOwner?: ChatComposer;
  private chromeOwner?: ChatChrome;
  private turnOwner?: ChatTurn;
  private actionsOwner?: ChatActions;
  private tabsEl!: HTMLElement;
  // The current active note's path. View-level: it follows the focused leaf,
  // not the conversation; each tab decides whether it is suppressed.
  private activeNotePath: string | null = null;
  // Semantic indexing can outlive the command that starts it; keep one
  // controller so cancel/running-state checks see the active AbortController.
  private semanticIndexWorkflow: SemanticIndexWorkflowController | null = null;

  private messagesEl!: HTMLElement;
  private transcript!: TranscriptView;
  private emptyStateEl: HTMLElement | null = null;
  private chipsEl!: HTMLElement;
  private fieldEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private modeToggleEl!: HTMLElement;
  private menu!: AutocompleteMenu;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private modelPillEl!: HTMLElement;
  private effortKnobEl!: HTMLElement;
  private usageEl!: HTMLElement;
  private contextBarEl!: HTMLProgressElement;
  private contextPercentEl!: HTMLElement;
  private workingEl!: HTMLElement;
  private closed = true;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: AgenticChatPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_AGENT_CHAT;
  }

  getDisplayText(): string {
    return "Agentic chat";
  }

  getIcon(): string {
    return "messages-square";
  }

  private get chatTabs(): ChatTabs {
    return (this.chatTabsOwner ??= new ChatTabs({
      createService: (handlers) => this.plugin.createAgentService(handlers),
      askUser: (tab, request, signal) => this.askUserForTab(tab, request, signal),
      confirmToolCall: (tab, request, signal) => this.confirmToolCallForTab(tab, request, signal),
      onActiveEvent: (event) => this.handleAgentEvent(event),
      onBackgroundFinished: (tabNumber) => {
        this.notifier.notify("agentFinished", `Tab ${tabNumber} finished responding.`);
      },
      isViewClosed: () => this.closed,
      container: () => this.tabsEl,
      composerValue: () => this.inputEl.value,
      setComposerValueQuiet: (value) => this.setComposerValueQuiet(value),
      setStatus: (text) => this.statusEl.setText(text),
      prepareSwitch: () => {
        this.cancelAutocomplete();
        this.menu.hide();
        this.endEditing(false);
      },
      endEditing: () => this.endEditing(false),
      renderChips: () => this.renderChips(),
      syncChrome: () => this.syncChrome(),
      flushQueuedPromptIfReady: () => this.flushQueuedPromptIfReady(),
      renderActiveTab: () => this.renderActiveTab(),
      initializeFreshTab: (tab) => this.initializeFreshTab(tab),
      startNewConversation: () => this.startNewConversation(),
    }));
  }

  private get composer(): ChatComposer {
    return (this.composerOwner ??= new ChatComposer({
      app: this.app,
      service: () => this.service,
      state: () => this.state,
      inputEl: () => this.inputEl,
      menu: () => this.menu,
      chipsEl: () => this.chipsEl,
      statusEl: () => this.statusEl,
      activeNotePath: () => this.activeNotePath,
      setActiveNotePath: (path) => {
        this.activeNotePath = path;
      },
      renderChips: () => this.renderChips(),
      syncChrome: () => this.syncChrome(),
    }));
  }

  private get chrome(): ChatChrome {
    return (this.chromeOwner ??= new ChatChrome({
      app: this.app,
      plugin: this.plugin,
      service: () => this.service,
      state: () => this.state,
      transcript: () => this.transcript,
      elements: {
        effortKnobEl: () => this.effortKnobEl,
        modelPillEl: () => this.modelPillEl,
        usageEl: () => this.usageEl,
        contextBarEl: () => this.contextBarEl,
        contextPercentEl: () => this.contextPercentEl,
        sendButton: () => this.sendButton,
        stopButton: () => this.stopButton,
        workingEl: () => this.workingEl,
        statusEl: () => this.statusEl,
      },
      isAnyTabStreaming: () => this.isAnyTabStreaming(),
      isViewFocused: () => this.app.workspace.getActiveViewOfType(ChatView) === this,
      syncControls: () => this.syncControls(),
    }, new Notifier(() => this.plugin.settings.notifications.enabled)));
  }

  private get turn(): ChatTurn {
    return (this.turnOwner ??= new ChatTurn({
      app: this.app,
      service: () => this.service,
      activeTab: () => this.activeTab,
      state: () => this.state,
      isLiveTab: (tab) => this.isLiveTab(tab),
      inputEl: () => this.inputEl,
      statusEl: () => this.statusEl,
      transcript: () => this.transcript,
      chrome: () => this.chrome,
      composer: () => this.composer,
      clearEmptyState: () => this.clearEmptyState(),
      effectiveActiveNote: () => this.effectiveActiveNote(),
      handleSlashCommand: (raw) => this.actions.handleSlashCommand(raw),
      sendPrompt: (text) => this.sendPrompt(text),
      renderErrorMessage: (message) => this.renderErrorMessage(message),
      renderOutgoingUserMessage: (text, attachments, images) => this.renderOutgoingUserMessage(text, attachments, images),
      renderTranscript: (messages) => this.renderTranscript(messages),
      showServiceError: () => this.showServiceError(),
      scrollToBottom: (options) => this.scrollToBottom(options),
      renderChips: () => this.renderChips(),
      syncChrome: () => this.syncChrome(),
    }));
  }

  private get actions(): ChatActions {
    return (this.actionsOwner ??= new ChatActions({
      slashCtx: () => this.slashCtx,
      service: () => this.service,
      tabs: () => this.chatTabs,
      switchToTab: (index) => this.switchToTab(index),
      loadConversation: (load) => this.createSessionActivationCoordinator().loadConversation(load),
      clearQueuedPrompt: () => this.composer.clearQueuedPrompt(),
      clearEmptyState: () => this.clearEmptyState(),
      renderErrorMessage: (message) => this.renderErrorMessage(message),
      renderInfoMessage: (title, entries) => this.renderInfoMessage(title, entries),
    }));
  }

  private get notifier(): Notifier {
    return this.chrome.notifier;
  }

  private addAttachment(entry: ContextAttachment): void {
    this.composer.addAttachment(entry);
  }

  private pushAttachment(entry: ContextAttachment): boolean {
    return this.composer.pushAttachment(entry);
  }

  private renderChips(): void {
    this.composer.renderChips();
  }

  private syncActiveNote(): void {
    this.composer.syncActiveNote();
  }

  private effectiveActiveNote(): string | null {
    return this.composer.effectiveActiveNote();
  }

  private beginEdit(index: number, displayText: string, el: HTMLElement): void {
    this.composer.beginEdit(index, displayText, el);
  }

  private cancelEditing(): void {
    this.composer.cancelEditing();
  }

  private endEditing(restoreDraft: boolean): void {
    this.composer.endEditing(restoreDraft);
  }

  private setComposerValue(value: string): void {
    this.composer.setComposerValue(value);
  }

  private setComposerValueQuiet(value: string): void {
    this.composer.setComposerValueQuiet(value);
  }

  private pushHistory(text: string): void {
    this.composer.pushHistory(text);
  }

  private resetHistoryNav(): void {
    this.composer.resetHistoryNav();
  }

  private recallHistory(direction: -1 | 1): boolean {
    return this.composer.recallHistory(direction);
  }

  private scheduleAutocomplete(): void {
    this.composer.scheduleAutocomplete();
  }

  private cancelAutocomplete(): void {
    this.composer.cancelAutocomplete();
  }

  private chooseAutocomplete(item: AcItem): void {
    this.composer.chooseAutocomplete(item);
  }

  private handleDrop(event: DragEvent): void {
    this.composer.handleDrop(event);
  }

  private queueComposerPrompt(): void {
    this.composer.queueComposerPrompt();
  }

  private clearQueuedPrompt(): void {
    this.composer.clearQueuedPrompt();
  }

  private get tabs(): ChatTab[] {
    return this.chatTabs.allTabs();
  }

  private set tabs(value: ChatTab[]) {
    this.chatTabs.setTabs(value);
  }

  private get activeTabIndex(): number {
    return this.chatTabs.activeIndexValue;
  }

  private set activeTabIndex(value: number) {
    this.chatTabs.setActiveIndex(value);
  }

  /** The active tab's agent service. Tabs are created before any service access. */
  private get service(): AgentService {
    return this.chatTabs.service;
  }

  private get activeTab(): ChatTab {
    return this.chatTabs.activeTab;
  }

  /** The active tab's working state: attachments, caches, queue, notifications, last send. */
  private get state(): ChatTabWorkingState {
    return this.activeTab.state;
  }

  private isLiveTab(tab: ChatTab): boolean {
    return this.chatTabs.isLiveTab(tab);
  }

  private switchToTab(index: number): Promise<void> {
    return this.chatTabs.switchToTab(index);
  }

  private tabLabel(tab: ChatTab): string {
    return this.chatTabs.tabLabel(tab);
  }

  private syncTabStrip(): void {
    this.chatTabs.syncTabStrip();
  }

  private async initializeFreshTab(tab: ChatTab): Promise<void> {
    await this.createSessionActivationCoordinator().initializeFreshTab(
      // A new tab is always a fresh session, never a continuation of tab 0's.
      () => tab.service.newSession(),
      (error) => new Notice(`Agentic chat: ${errorMessage(error)}`),
    );
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.buildLayout();
    // First tab continues the most-recent session (initialize); later tabs each
    // start a fresh session. Each tab's service has its own event subscription.
    this.chatTabs.setTabs([this.chatTabs.createTab()]);
    // The mention list is cached; drop it whenever the vault's file set changes.
    const invalidate = () => {
      this.composer.invalidateMentionCache();
    };
    this.registerEvent(this.app.vault.on("create", invalidate));
    this.registerEvent(this.app.vault.on("delete", invalidate));
    this.registerEvent(this.app.vault.on("rename", invalidate));
    this.registerEvent(this.app.vault.on("modify", invalidate));
    // Keep the auto-attached active note in sync as the focused leaf/file changes.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncActiveNote()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.syncActiveNote()));
    await this.createSessionActivationCoordinator().initializeActiveSession(
      () => this.service.initialize(),
      (error) => new Notice(`Agentic chat: ${errorMessage(error)}`),
    );
  }

  async onClose(): Promise<void> {
    this.closed = true;
    this.cancelAutocomplete();
    this.menu?.detach();
    this.transcript?.dispose();
    // The view owns the semantic index run; abort it so a closed view cannot
    // keep writing the index in the background.
    this.semanticIndexWorkflow?.dispose();
    this.semanticIndexWorkflow = null;
    // The view owns its tab services; dispose them so no detached agent keeps running.
    for (const tab of this.tabs) {
      tab.unsubscribe();
      tab.pendingApprovalModal?.close();
      tab.service.dispose();
    }
    this.tabs = [];
  }

  /** Add a vault file/folder from an Obsidian context menu to the next prompt. */
  attachVaultEntryFromMenu(entry: TFile | TFolder): void {
    const attachment = entry instanceof TFolder ? `${FOLDER_PREFIX}${entry.path}` : entry.path;
    this.addAttachment(attachment);
    this.inputEl.focus();
  }

  /** Add selected editor text from an Obsidian context menu to the next prompt. */
  attachSelectionFromMenu(text: string, sourcePath?: string): void {
    const selected = text.trim();
    if (!selected) return;
    if (sourcePath && this.service.isPathIgnored(sourcePath)) {
      new Notice("That selection is in an ignored note, so Agentic Chat will not attach it.");
      return;
    }
    const attachment = createTextContextAttachment({ text: selected, sourcePath });
    this.pushAttachment(attachment);
    this.inputEl.focus();
  }

  /** Re-render the transcript + chrome for the active tab (after a switch/close). */
  private renderActiveTab(): void {
    this.createSessionActivationCoordinator().renderActiveTab();
    // Chips depend on the newly active tab's state; the
    // coordinator only syncs chrome, so re-render them here or a queued-prompt
    // chip (and context chips) would stay stale/invisible after a tab switch.
    this.renderChips();
  }

  private async askUserForTab(tab: ChatTab, request: AskUserRequest, signal?: AbortSignal): Promise<string> {
    const index = this.tabs.indexOf(tab);
    if (index === -1) throw new Error("The chat tab that asked the question is no longer open.");
    if (tab !== this.activeTab) await this.switchToTab(index);
    return await this.renderAskUserPrompt(request, signal);
  }

  /** Notify + label for background tool approvals (no auto-switch). */
  private async confirmToolCallForTab(
    tab: ChatTab,
    request: ToolApprovalRequest,
    signal?: AbortSignal,
  ): Promise<UserApprovalChoice> {
    const index = this.tabs.indexOf(tab);
    if (index === -1) throw new Error("The chat tab that requested approval is no longer open.");
    const isBackground = tab !== this.activeTab;
    const sessionLabel = `Tab ${index + 1} • ${this.tabLabel(tab)}`;
    const labeledRequest: ToolApprovalRequest = isBackground ? { ...request, sessionLabel } : request;
    if (isBackground) {
      tab.needsApproval = true;
      this.syncTabStrip();
      this.notifier.notify("approval", `${sessionLabel} needs approval: ${request.label}`);
    }
    const modal = new ApprovalModal(this.app, labeledRequest, () => tab.service.abort());
    tab.pendingApprovalModal = modal;
    try {
      const choice = await modal.ask(signal);
      if (applyRememberedApprovalChoice(this.plugin.settings, request.toolName, choice)) {
        await this.plugin.saveSettings();
      }
      return choice;
    } finally {
      tab.pendingApprovalModal = undefined;
      if (tab.needsApproval) {
        tab.needsApproval = false;
        this.syncTabStrip();
      }
    }
  }

  private async renderAskUserPrompt(request: AskUserRequest, signal?: AbortSignal): Promise<string> {
    this.clearEmptyState();
    const el = this.messagesEl.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info", "agentic-chat-ask-user"] });
    const details = el.createEl("details", { cls: "agentic-chat-info-details" });
    details.open = true;
    details.createEl("summary", { text: "Question from agent" });
    const body = details.createDiv({ cls: "agentic-chat-info-body" });
    body.createDiv({ cls: "agentic-chat-ask-question", text: request.question });
    const answerState = body.createDiv({ cls: "agentic-chat-ask-state", text: "Waiting for your answer." });
    const controls = body.createDiv({ cls: "agentic-chat-ask-controls" });
    const choices = request.choices.length ? controls.createDiv({ cls: "agentic-chat-ask-choices" }) : null;
    const textarea = controls.createEl("textarea", {
      cls: "agentic-chat-ask-input",
      attr: { rows: "3", placeholder: "Type an answer..." },
    });
    const submit = controls.createEl("button", { cls: ["mod-cta", "agentic-chat-ask-submit"], text: "Send answer" });

    this.scrollToBottom({ force: true });
    textarea.focus();

    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const settle = (answer: string) => {
        const trimmed = answer.trim();
        if (!trimmed || settled) {
          textarea.focus();
          return;
        }
        settled = true;
        cleanup();
        textarea.disabled = true;
        submit.disabled = true;
        controls.addClass("is-answered");
        answerState.setText(`Answered: ${trimmed}`);
        el.detach();
        this.scrollToBottom({ force: true });
        resolve(trimmed);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        textarea.disabled = true;
        submit.disabled = true;
        controls.addClass("is-cancelled");
        answerState.setText("Question cancelled.");
        reject(new Error("ask_user was cancelled."));
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      for (const choice of request.choices) {
        choices?.createEl("button", { cls: "agentic-chat-ask-choice", text: choice }).addEventListener("click", () => settle(choice));
      }
      submit.addEventListener("click", () => settle(textarea.value));
      textarea.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          settle(textarea.value);
        }
      });
    });
  }

  /** Public entry for the "New conversation" command: fresh session in the active tab. */
  async startNewConversation(): Promise<void> {
    await this.newSession();
  }

  private buildLayout(): void {
    const layout = buildChatLayout({
      app: this.app,
      component: this,
      contentEl: this.contentEl,
      registerDomEvent: (el, type, handler) => this.registerDomEvent(el, type, handler),
      callbacks: {
        renderEmptyState: () => this.renderEmptyState(),
        beginEdit: (index, text, el) => this.beginEdit(index, text, el),
        retryLast: () => void this.retryLast(),
        abortSubagentChild: (id) => this.service.abortSubagentChild(id),
        chooseAutocomplete: (item) => this.chooseAutocomplete(item),
        submit: (source) => void this.submit(source),
        stopActiveTurn: () => this.stopActiveTurn(),
        cancelEditing: () => this.cancelEditing(),
        recallHistory: (direction) => this.recallHistory(direction),
        resetHistoryNav: () => this.resetHistoryNav(),
        scheduleAutocomplete: () => this.scheduleAutocomplete(),
        cancelAutocomplete: () => this.cancelAutocomplete(),
        handleDrop: (event) => this.handleDrop(event),
        cycleEffort: () => void this.cycleEffort(),
        toggleMode: () => this.toggleMode(),
        switchModel: () => void this.switchModel(),
        newSession: () => void this.newSession(),
        openHistory: () => void this.actions.createSessionWorkflow().run(""),
        isEditing: () => this.composer.isEditing,
        reconcileQueuedInput: (value, event) => this.reconcileQueuedInput(value, event),
      },
    });
    this.messagesEl = layout.messagesEl;
    // The empty state renders into messagesEl, so it needs the field set first.
    this.renderEmptyState();
    this.transcript = layout.transcript;
    this.tabsEl = layout.tabsEl;
    this.chipsEl = layout.chipsEl;
    this.fieldEl = layout.fieldEl;
    this.inputEl = layout.inputEl;
    this.modeToggleEl = layout.modeToggleEl;
    this.menu = layout.menu;
    this.sendButton = layout.sendButton;
    this.stopButton = layout.stopButton;
    this.statusEl = layout.statusEl;
    this.modelPillEl = layout.modelPillEl;
    this.effortKnobEl = layout.effortKnobEl;
    this.usageEl = layout.usageEl;
    this.contextBarEl = layout.contextBarEl;
    this.contextPercentEl = layout.contextPercentEl;
    this.workingEl = layout.workingEl;
  }

  /** Keep the queued-prompt chip in step with real typing, but not IME composition. */
  private reconcileQueuedInput(value: string, inputEvent: UIEvent): void {
    if (!this.state.queuedPromptArmed || (inputEvent.instanceOf(InputEvent) && inputEvent.isComposing)) return;
    const text = value.trim();
    if (!text) {
      this.state.queuedPromptArmed = false;
      this.statusEl.setText("");
      this.syncChrome();
      this.renderChips();
    } else if (text !== this.composer.pendingChipPreview) {
      this.renderChips();
    }
  }

  /** The one gate for the Safe <-> YOLO toggle; `setMode` refuses while streaming. */
  private toggleMode(): void {
    const target = this.plugin.settings.mode === "yolo" ? "safe" : "yolo";
    void this.setMode(target);
  }

  private renderEmptyState(): void {
    this.emptyStateEl = this.messagesEl.createDiv({ cls: "agentic-chat-empty" });
    const icon = this.emptyStateEl.createDiv({ cls: "agentic-chat-empty-icon" });
    setIcon(icon, "bot");
    this.emptyStateEl.createDiv({
      cls: "agentic-chat-empty-text",
      text: "Ask anything about your vault. The agent can read, search, write, and edit notes — every tool call is shown inline. Type / for commands or @ to attach a note.",
    });
    // Suggested prompts fill the empty surface with a low-effort starting point
    // (teaches / and @ without a manual) instead of a big vertical void.
    const suggestions = [
      "Read the active note and summarize it",
      "List notes changed in the last week",
      "Draft a weekly overview of my vault",
    ];
    const row = this.emptyStateEl.createDiv({ cls: "agentic-chat-empty-suggestions" });
    for (const suggestion of suggestions) {
      const chip = row.createEl("button", { cls: "agentic-chat-empty-suggestion", text: suggestion });
      chip.addEventListener("click", () => {
        this.inputEl.value = suggestion;
        void this.submit("button");
      });
    }
  }

  private clearEmptyState(): void {
    this.emptyStateEl?.detach();
    this.emptyStateEl = null;
  }

  // --- composer controls (Safe ↔ YOLO toggle) ---
  // S4: all mode mutations (toggle, settings tab) funnel through
  // validateModeTransition + resolveModeTransition so the two surfaces stay
  // atomically in sync (Codex ThreadSettingsOverrides pattern).

  private async setMode(mode: AgentMode): Promise<boolean> {
    const current = this.plugin.settings.mode;
    const blocked = validateModeTransition(this.plugin.isAnyViewStreaming() || this.isAnyTabStreaming());
    if (blocked) {
      if (current !== mode) this.renderErrorMessage(blocked);
      return false;
    }
    if (current === mode) return false;
    const transition = resolveModeTransition(current, mode);
    if (!transition) return false;
    this.plugin.settings.mode = transition.nextMode;
    await this.plugin.saveSettings();
    // Repaint the whole chrome so the Safe↔YOLO segment + aria-checked flip
    // instantly after the mode lands on disk (syncChrome calls syncControls).
    this.syncChrome();
    return true;
  }

  /** S4: external callers (settings tab) route through the active view. */
  async requestModeChange(mode: AgentMode): Promise<boolean> {
    return this.setMode(mode);
  }

  /** Whether the current tab's agent is streaming — exposed for the plugin's S4 broadcast. */
  isStreaming(): boolean {
    return this.isAnyTabStreaming();
  }

  /** Whether any tab in this leaf is streaming — covers background tabs for the settings gate. */
  private isAnyTabStreaming(): boolean {
    return this.chatTabs.isAnyTabStreaming();
  }

  /** S4: called by the plugin after any persisted mode change (e.g. settings tab) so every leaf reflects the single source atomically. */
  refreshModeFromSettings(): void {
    this.syncChrome();
  }

  private async setOutputStyle(style: OutputStyle): Promise<void> {
    if (this.service.isStreaming()) return;
    if (this.plugin.settings.outputStyle === style) return;
    this.plugin.settings.outputStyle = style;
    await this.plugin.saveSettings();
    this.syncControls();
  }

  /**
   * Reflect settings (e.g. changed via the settings tab) back into the composer
   * toggle, and disable it while the agent is streaming so the posture can't
   * drift from the prompt/policy the in-flight turn started under.
   */
  private syncControls(): void {
    if (!this.modeToggleEl) return;
    const { settings } = this.plugin;
    const streaming = this.plugin.isAnyViewStreaming() || this.isAnyTabStreaming();
    this.modeToggleEl.toggleClass("is-active", settings.mode === "yolo");
    this.modeToggleEl.toggleClass("is-disabled", streaming);
    this.modeToggleEl.setAttr("aria-checked", String(settings.mode === "yolo"));
    this.modeToggleEl.setAttr("aria-label", `Permission mode: ${settings.mode === "yolo" ? "YOLO" : "Safe"}`);
    // Effort can't change mid-turn (it would disagree with the in-flight request).
    this.effortKnobEl?.toggleClass("is-disabled", streaming);
  }

  // --- chrome (header pill, usage, running state) ---

  private syncChrome(): void {
    this.chrome.syncChrome();
  }

  private syncEffortKnob(): void {
    this.chrome.syncEffortKnob();
  }

  // --- submission + slash commands ---

  private async submit(source: ComposerSubmitSource): Promise<void> {
    this.cancelAutocomplete();
    this.menu.hide();
    await this.turn.submit(source);
  }

  /** Stop the turn and cancel the composer hold, keeping the draft for a new send. */
  private stopActiveTurn(): void {
    this.turn.stopActiveTurn();
  }

  private async flushQueuedPromptIfReady(): Promise<void> {
    await this.turn.flushQueuedPromptIfReady();
  }

  /** Rewind to `index`, drop that turn and everything after, then send the edit. */
  private async editAndResend(index: number, text: string): Promise<void> {
    await this.turn.editAndResend(index, text);
  }

  private async sendPrompt(text: string): Promise<void> {
    await this.turn.sendPrompt(text);
  }

  private async steerActiveTurn(text: string): Promise<void> {
    await this.turn.steerActiveTurn(text);
  }

  /** Re-run the conversation's last user turn (inline "Ask again" action). */
  private async retryLast(): Promise<void> {
    await this.turn.retryLast();
  }

  private async handleSlashCommand(raw: string): Promise<boolean> {
    return this.actions.handleSlashCommand(raw);
  }

  /** Narrow view of this view for the slash handler modules. */
  private slashContext: SlashContext | undefined;

  private get slashCtx(): SlashContext {
    // A real object (not a cast of `this`), so the compiler checks every member.
    // State members are accessors: handlers must see and set the live view state.
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- accessors below read live view state
    const view = this;
    return (this.slashContext ??= {
      get service() { return view.service; },
      get plugin() { return view.plugin; },
      get app() { return view.app; },
      get inputEl() { return view.inputEl; },
      get activeNotePath() { return view.activeNotePath; },
      get semanticIndexWorkflow() { return view.semanticIndexWorkflow; },
      set semanticIndexWorkflow(value) { view.semanticIndexWorkflow = value; },
      clearEmptyState: () => view.clearEmptyState(),
      renderInfoMessage: (title, entries) => view.renderInfoMessage(title, entries),
      renderActionList: (title, subtitle, items) => view.renderActionList(title, subtitle, items),
      renderErrorMessage: (message) => view.renderErrorMessage(message),
      showServiceError: () => view.showServiceError(),
      renderOutgoingUserMessage: (text, attachments, images) => view.renderOutgoingUserMessage(text, attachments, images),
      renderTranscript: (messages) => view.renderTranscript(messages),
      syncChrome: () => view.syncChrome(),
      setOutputStyle: (style) => view.setOutputStyle(style),
      setComposerValue: (text) => view.setComposerValue(text),
      createSessionWorkflow: () => view.actions.createSessionWorkflow(),
      createSessionActivationCoordinator: () => view.createSessionActivationCoordinator(),
      createMemoryWorkflow: () => view.actions.createMemoryWorkflow(),
      semanticIndexWorkflowController: () => view.actions.semanticIndexWorkflowController(),
      workflowRenderer: () => view.actions.workflowRenderer(),
      clearAllSessions: () => view.actions.clearAllSessions(),
      loadSession: (path) => view.actions.loadSession(path),
      deleteSessionFromList: (path) => view.actions.deleteSessionFromList(path),
    });
  }

  private createSessionActivationCoordinator(): SessionActivationCoordinator {
    return new SessionActivationCoordinator({
      setMuteNotifications: (muted) => {
        this.chrome.setMuteNotifications(muted);
      },
      resetUsageNotifications: (muteExisting) => this.chrome.resetUsageNotifications(muteExisting),
      resetUiState: (options) => this.resetSessionUiState(options),
      messages: () => this.service.getMessages(),
      renderTranscript: (messages) => this.renderTranscript(messages),
      syncActiveNote: () => this.syncActiveNote(),
      syncTabStrip: () => this.syncTabStrip(),
      syncChrome: () => this.syncChrome(),
      flushQueuedPromptIfReady: () => this.flushQueuedPromptIfReady(),
    });
  }

  private resetSessionUiState(options: SessionUiResetOptions): void {
    resetChatTabState(this.state, options);
    if (options.editing) this.endEditing(false);
    if (options.bubble) this.transcript.forgetBubble();
    if (options.queuedPrompt) this.clearQueuedPrompt();
  }

  /** Composer effort knob: cycle to the next supported reasoning level. */
  private async cycleEffort(): Promise<void> {
    if (this.service.isStreaming()) return;
    const levels = this.service.getActiveThinkingLevels();
    if (levels.length <= 1) {
      this.syncEffortKnob();
      new Notice("Current model does not expose alternate reasoning effort levels.");
      return;
    }
    const current = this.service.getActiveThinkingLevel();
    const index = levels.indexOf(current);
    const next = levels[(index + 1) % levels.length];
    try {
      await persistEffortLevel(this.slashCtx, next);
    } catch {
      // persistEffortLevel already rolled the knob back to the saved level.
      new Notice("Could not save effort level.");
    }
  }

  private runSemanticIndex(arg: string): Promise<void> { return this.actions.runSemanticIndex(arg); }

  /** Render a collapsible info block in the transcript (not sent to the model). */
  private renderInfoMessage(title: string, entries: Array<[string, string]>): void {
    renderInfoPanel(this.messagesEl, title, entries);
    this.scrollToBottom({ force: true });
  }

  /** Render a collapsible block whose rows are clickable buttons (e.g. the skill picker). */
  private renderActionList(title: string, subtitle: string, items: ActionRow[]): void {
    renderActionPanel(this.messagesEl, title, subtitle, items);
    this.scrollToBottom();
  }

  private showServiceError(): void {
    const error = this.service.getError();
    // Skip the standalone error panel when this same error was already rendered
    // inside the just-finalized assistant bubble (avoids the duplicate block).
    if (error && !this.service.isStreaming() && error !== this.transcript.lastBubbleError) this.renderErrorMessage(error);
  }

  /** Render an error block in the transcript (not sent to the model). */
  private renderErrorMessage(message: string): void {
    this.clearEmptyState();
    renderErrorPanel(this.messagesEl, message);
    this.scrollToBottom();
  }

  // --- session + model actions ---

  private newSession(): Promise<void> { return this.actions.newSession(); }

  /** Delete from the history list; only the active session swaps under us. */
  private deleteSessionFromList(path: string): Promise<void> { return this.actions.deleteSessionFromList(path); }

  /**
   * Clear all conversations; the active session is replaced afterwards.
   * Returns -1 on failure so the caller does not report success or reset the
   * transcript after a failed clear.
   */
  private async clearAllSessions(): Promise<number> {
    return this.actions.clearAllSessions();
  }

  private async loadSession(path: string): Promise<void> {
    await this.actions.loadSession(path);
  }

  private switchModel(): Promise<void> { return this.actions.switchModel(); }

  private handleAgentEvent(event: AgentEvent): void {
    this.turn.handleAgentEvent(event);
  }

  // --- transcript entry points (the TranscriptView owns the pane) ---

  private renderTranscript(messages: AgentMessage[]): void {
    this.transcript.renderTranscript(messages);
  }

  private renderOutgoingUserMessage(text: string, attachments: ContextAttachment[], images?: ImageContent[]): void {
    this.transcript.renderOutgoingUserMessage(text, attachments, images);
  }

  private scrollToBottom(options: { force?: boolean } = {}): void {
    this.transcript.scrollToBottom(options);
  }
}
