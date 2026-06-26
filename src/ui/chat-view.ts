import {
  ItemView,
  Notice,
  TFile,
  TFolder,
  type WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type { AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type AgenticChatPlugin from "../main";
import type { AgentService } from "../agent/agent-service";
import type { AskUserRequest } from "../tools/ask-user-tool";
import { isImagePath } from "./image-attachments";
import { EXPORT_FOLDER, exportFileName, hasExportableTurns, sessionToMarkdown } from "../session/export";
import { VIEW_TYPE_AGENT_CHAT } from "../constants";
import { activeModelId, THINKING_LEVELS } from "../settings";
import { listOpenRouterModels } from "../llm/models";
import { ModelSuggestModal } from "./model-suggest-modal";
import { SessionListModal } from "./session-list-modal";
import { FolderSuggestModal } from "./folder-suggest";
import { highestUnnotifiedThreshold, Notifier } from "./notifications";
import { AssistantBubble } from "./assistant-bubble";
import { cacheHitPercent, formatCost, formatUsage, safeJson, shortModelLabel } from "./format";
import { contextLevel, contextPercent } from "./context-bar";
import {
  assistantUsage,
  collectToolResults,
  lastUserText,
  messageText,
  thinkingText,
  toolCalls,
  type ToolResultLite,
  toolResultText,
} from "./message-content";
import {
  type AcItem,
  type AcQuery,
  detectQuery,
  FOLDER_PREFIX,
  type MentionCandidate,
  resolve,
  suggest,
} from "./autocomplete";
import { AutocompleteMenu } from "./autocomplete-menu";
import { parseDroppedVaultPath } from "./drag-drop";
import { ComposerHistory } from "./composer-history";
import { PromptEditState } from "./prompt-edit-state";
import { freshChatTabState, type ChatTabWorkingState } from "./chat-tab-state";
import { buildPromptContext, loadImageAttachments as loadContextImageAttachments } from "./context-builder";
import { attachmentBasePath } from "./attachment-ref";
import {
  contextAttachmentKey,
  contextAttachmentLabel,
  createTextContextAttachment,
  isTextContextAttachment,
  type ContextAttachment,
} from "./context-attachments";
import { resolveCommand, visibleCommands } from "./commands";
import { isPinnedToBottom } from "./scroll-pinning";
import { normalizeFolderPath } from "../vault/path";
import { isSummaryMessage } from "../agent/compaction";
import { type AgentMode, enterPlan, exitPlan, MODE_ORDER, MODES } from "../agent/modes";
import {
  type ActiveNoteState,
  autoActiveNotePath,
  effectiveActiveNote,
} from "./active-note";
import { DEFAULT_OUTPUT_STYLE, type OutputStyle, OUTPUT_STYLE_ORDER, OUTPUT_STYLES } from "../agent/output-styles";
import {
  formatMcpDiagnosticRows,
  formatMcpDiagnosticSummary,
  formatRuntimeDiagnosticsRows,
} from "../agent/diagnostics";

export { VIEW_TYPE_AGENT_CHAT };

/** Context-window fill fractions that trigger a background notification, once each. */
const CONTEXT_THRESHOLDS = [0.75, 0.9] as const;

/** Strip an attachment `<context>…</context>` preamble for display (used by retry fallback). */
function stripContextPreamble(text: string): string {
  return text.replace(/^<context>[\s\S]*?<\/context>\n\n/, "");
}

interface ActionRow {
  label: string;
  detail?: string;
  icon: string;
  onClick: () => void;
}

/** Maximum independent sessions ("tabs") in one chat leaf. */
const MAX_TABS = 3;

/** One open conversation in the leaf: its own agent service + saved UI state. */
interface ChatTab {
  service: AgentService;
  unsubscribe: () => void;
  state: ChatTabWorkingState;
}

/** Minimal shape of Obsidian's internal (undocumented) drag manager. */
interface ObsidianDragManager {
  draggable?: { file?: unknown; files?: unknown[] } | null;
}

export class ChatView extends ItemView {
  // Open tabs (independent sessions). The fields below mirror the *active* tab's
  // working state; switchToTab saves/loads them against `tabs[activeTabIndex].state`.
  private tabs: ChatTab[] = [];
  private activeTabIndex = 0;
  private tabsEl!: HTMLElement;
  private attachments: ContextAttachment[] = [];
  // Active-note-attached-by-default state: the current active note's path, whether
  // the user dismissed the auto chip (suppressed for the session), and — when in
  // plan mode — the posture to restore on /endplan.
  private activeNotePath: string | null = null;
  private activeNoteSuppressed = false;
  private modeBeforePlan: AgentMode | null = null;
  private bubble: AssistantBubble | null = null;
  private readonly notifier = new Notifier(() => this.plugin.settings.notifications.enabled);
  private notifiedContext = new Set<number>();
  private notifiedCost = false;
  // Compaction count last surfaced to the user, so each compaction toasts once.
  private lastCompactionCount = 0;
  // The service fires onChange synchronously during session transitions; this silences
  // automatic toasts until the new session's notification baseline has been set.
  private muteNotifications = false;

  // Autocomplete state: the active query token and a cached mention candidate list.
  private activeQuery: AcQuery | null = null;
  private mentionCache: MentionCandidate[] | null = null;
  // Last turn we sent, kept so "retry" re-runs it without re-showing the context preamble.
  private lastSentPrompt: string | null = null;
  private lastSentDisplay: string | null = null;
  private editingEl: HTMLElement | null = null;
  private readonly promptEdit = new PromptEditState();

  private messagesEl!: HTMLElement;
  private emptyStateEl: HTMLElement | null = null;
  private chipsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private safeButtonEl!: HTMLButtonElement;
  private yoloButtonEl!: HTMLButtonElement;
  private modeToggleEl!: HTMLElement;
  private planBadgeEl!: HTMLElement;
  private menu!: AutocompleteMenu;
  // Shell-style command history: every submitted message, newest last. The
  // helper owns navigation/draft state so ChatView only applies returned values.
  private readonly composerHistory = new ComposerHistory();
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private modelPillEl!: HTMLElement;
  private effortKnobEl!: HTMLElement;
  private usageEl!: HTMLElement;
  private contextBarEl!: HTMLProgressElement;
  private contextPercentEl!: HTMLElement;
  private workingEl!: HTMLElement;
  private folderButtonEl!: HTMLButtonElement;
  private autoScrollPinned = true;
  private userScrollIntent = false;
  private userScrollIntentTimer: number | null = null;

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

  /** The active tab's agent service. Tabs are created before any service access. */
  private get service(): AgentService {
    return this.tabs[this.activeTabIndex].service;
  }

  private get activeTab(): ChatTab {
    return this.tabs[this.activeTabIndex];
  }

  async onOpen(): Promise<void> {
    this.buildLayout();
    // First tab continues the most-recent session (initialize); later tabs each
    // start a fresh session. Each tab's service has its own event subscription.
    this.tabs = [this.createTab()];
    this.activeTabIndex = 0;
    // The mention list is cached; drop it whenever the vault's file set changes.
    const invalidate = () => {
      this.mentionCache = null;
    };
    this.registerEvent(this.app.vault.on("create", invalidate));
    this.registerEvent(this.app.vault.on("delete", invalidate));
    this.registerEvent(this.app.vault.on("rename", invalidate));
    // Keep the auto-attached active note in sync as the focused leaf/file changes.
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.syncActiveNote()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.syncActiveNote()));
    this.muteNotifications = true;
    try {
      await this.service.initialize();
    } catch (error) {
      new Notice(`Agentic chat: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // Baseline against the continued session so reopening doesn't toast existing crossings.
      this.resetUsageNotifications(true);
      this.muteNotifications = false;
    }
    this.syncActiveNote();
    this.renderTranscript(this.service.getMessages());
    this.syncChrome();
    this.syncTabStrip();
  }

  async onClose(): Promise<void> {
    this.cancelAutocomplete();
    if (this.userScrollIntentTimer !== null) window.clearTimeout(this.userScrollIntentTimer);
    this.userScrollIntentTimer = null;
    // The view owns its tab services; dispose them so no detached agent keeps running.
    for (const tab of this.tabs) {
      tab.unsubscribe();
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
    if (sourcePath) {
      this.activeNoteSuppressed = true;
      if (this.activeNotePath === sourcePath) this.activeNotePath = null;
    }
    this.pushAttachment(attachment);
    this.inputEl.focus();
  }

  // --- tabs (independent sessions in one leaf) ---

  /** Build a tab with its own agent service and a tab-aware event subscription. */
  private createTab(): ChatTab {
    const tabRef: { current?: ChatTab } = {};
    const service = this.plugin.createAgentService({
      askUser: (request, signal) => {
        if (!tabRef.current) throw new Error("The chat tab is not ready to ask the user.");
        return this.askUserForTab(tabRef.current, request, signal);
      },
    });
    const tab: ChatTab = { service, unsubscribe: () => {}, state: freshChatTabState() };
    tabRef.current = tab;
    const offEvent = service.onEvent((event) => this.handleTabEvent(tab, event));
    const offChange = service.onChange(() => this.handleTabChange(tab));
    tab.unsubscribe = () => {
      offEvent();
      offChange();
    };
    return tab;
  }

  /** Snapshot the active tab's composer/UI state so it survives a switch. */
  private saveActiveState(): void {
    const tab = this.tabs[this.activeTabIndex];
    if (!tab) return;
    tab.state = {
      attachments: this.attachments,
      activeNoteSuppressed: this.activeNoteSuppressed,
      draft: this.inputEl.value,
      sentHistory: this.composerHistory.entries(),
      notifiedContext: this.notifiedContext,
      notifiedCost: this.notifiedCost,
      lastCompactionCount: this.lastCompactionCount,
      lastSentPrompt: this.lastSentPrompt,
      lastSentDisplay: this.lastSentDisplay,
    };
  }

  /** Restore the active tab's saved composer/UI state into the live fields. */
  private loadActiveState(): void {
    const tab = this.tabs[this.activeTabIndex];
    if (!tab) return;
    const state = tab.state;
    this.attachments = state.attachments;
    this.activeNoteSuppressed = state.activeNoteSuppressed;
    this.composerHistory.load(state.sentHistory);
    this.notifiedContext = state.notifiedContext;
    this.notifiedCost = state.notifiedCost;
    this.lastCompactionCount = state.lastCompactionCount;
    this.lastSentPrompt = state.lastSentPrompt;
    this.lastSentDisplay = state.lastSentDisplay;
    this.setComposerValueQuiet(state.draft);
  }

  /** Re-render the transcript + chrome for the active tab (after a switch/close). */
  private renderActiveTab(): void {
    this.bubble = null;
    this.endEditing(false);
    // Don't toast about the incoming tab's already-existing context/cost state.
    this.muteNotifications = true;
    this.syncActiveNote();
    this.renderTranscript(this.service.getMessages());
    this.syncChrome();
    this.muteNotifications = false;
    this.syncTabStrip();
  }

  private async switchToTab(index: number): Promise<void> {
    if (index === this.activeTabIndex || index < 0 || index >= this.tabs.length) return;
    this.cancelAutocomplete();
    this.menu.hide();
    this.endEditing(false);
    this.saveActiveState();
    this.activeTabIndex = index;
    this.loadActiveState();
    this.renderActiveTab();
  }

  /** `+`: open a new tab on a fresh session and switch to it (capped at MAX_TABS). */
  private async addTab(): Promise<void> {
    if (this.tabs.length >= MAX_TABS) return;
    this.endEditing(false);
    this.saveActiveState();
    const tab = this.createTab();
    this.tabs.push(tab);
    this.activeTabIndex = this.tabs.length - 1;
    // Reset the live fields to this fresh tab before any async work renders against them.
    this.loadActiveState();
    this.muteNotifications = true;
    try {
      // A new tab is always a fresh session, never a continuation of tab 0's.
      await tab.service.newSession();
      this.resetUsageNotifications();
    } catch (error) {
      new Notice(`Agentic chat: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.muteNotifications = false;
    }
    this.renderActiveTab();
  }

  /** `×`: close a tab, disposing its session. Closing the only tab resets it instead. */
  private closeTab(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    if (this.tabs.length <= 1) {
      void this.startNewConversation();
      return;
    }
    const closingActive = index === this.activeTabIndex;
    if (closingActive) this.endEditing(false);
    const [tab] = this.tabs.splice(index, 1);
    tab.unsubscribe();
    tab.service.dispose();
    if (index < this.activeTabIndex) {
      this.activeTabIndex -= 1;
    } else if (closingActive) {
      this.activeTabIndex = Math.min(this.activeTabIndex, this.tabs.length - 1);
      // The closed tab was showing; load + render whichever tab took its place.
      this.loadActiveState();
      this.renderActiveTab();
      return;
    }
    this.syncTabStrip();
  }

  private tabLabel(tab: ChatTab): string {
    const info = tab.service.getSessionInfo();
    return info?.name?.trim() || "New chat";
  }

  /** Activate `el` on click and on Enter/Space, so non-button controls are keyboard-usable. */
  private onActivate(el: HTMLElement, handler: () => void, stopPropagation = false): void {
    el.addEventListener("click", (event) => {
      if (stopPropagation) event.stopPropagation();
      handler();
    });
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (stopPropagation) event.stopPropagation();
      handler();
    });
  }

  /** Render the tab pills + add button, reflecting active/busy state. */
  private syncTabStrip(): void {
    if (!this.tabsEl) return;
    this.tabsEl.empty();
    this.tabs.forEach((tab, index) => {
      const active = index === this.activeTabIndex;
      const pill = this.tabsEl.createDiv({
        cls: "agentic-chat-tab",
        attr: { role: "tab", tabindex: "0", "aria-selected": String(active), "aria-label": this.tabLabel(tab), title: this.tabLabel(tab) },
      });
      pill.toggleClass("is-active", active);
      pill.createSpan({ cls: "agentic-chat-tab-num", text: String(index + 1) });
      if (tab.service.isStreaming()) pill.createSpan({ cls: "agentic-chat-tab-busy", attr: { "aria-hidden": "true" } });
      this.onActivate(pill, () => void this.switchToTab(index));
      if (this.tabs.length > 1) {
        const close = pill.createSpan({
          cls: "agentic-chat-tab-close",
          attr: { role: "button", tabindex: "0", "aria-label": "Close tab" },
        });
        setIcon(close, "x");
        this.onActivate(close, () => this.closeTab(index), true);
      }
    });
    if (this.tabs.length < MAX_TABS) {
      const add = this.tabsEl.createDiv({
        cls: "agentic-chat-tab-add",
        attr: { role: "button", tabindex: "0", "aria-label": "New tab", title: "New tab" },
      });
      setIcon(add, "plus");
      this.onActivate(add, () => void this.addTab());
    }
  }

  private handleTabEvent(tab: ChatTab, event: AgentEvent): void {
    if (tab === this.activeTab) {
      this.handleAgentEvent(event);
      return;
    }
    // A background tab finishing while you're viewing another: surface it.
    if (event.type === "agent_end") {
      this.notifier.notify("agentFinished", `Tab ${this.tabs.indexOf(tab) + 1} finished responding.`);
    }
    this.syncTabStrip();
  }

  private handleTabChange(tab: ChatTab): void {
    this.syncTabStrip();
    if (tab === this.activeTab) this.syncChrome();
  }

  private async askUserForTab(tab: ChatTab, request: AskUserRequest, signal?: AbortSignal): Promise<string> {
    const index = this.tabs.indexOf(tab);
    if (index === -1) throw new Error("The chat tab that asked the question is no longer open.");
    if (tab !== this.activeTab) await this.switchToTab(index);
    return await this.renderAskUserPrompt(request, signal);
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
    const root = this.contentEl;
    root.empty();
    root.addClass("agentic-chat-view");

    this.messagesEl = root.createDiv({ cls: "agentic-chat-messages" });
    this.registerDomEvent(this.messagesEl, "wheel", () => this.markUserScrollIntent());
    this.registerDomEvent(this.messagesEl, "touchmove", () => this.markUserScrollIntent());
    this.registerDomEvent(this.messagesEl, "pointerdown", () => this.markUserScrollIntent());
    this.registerDomEvent(this.messagesEl, "keydown", () => this.markUserScrollIntent());
    this.registerDomEvent(this.messagesEl, "scroll", () => this.updateScrollPinning());
    this.renderEmptyState();

    const composer = root.createDiv({ cls: "agentic-chat-composer" });

    // Nav row above the input card: tab pills on the left (switch between up to
    // MAX_TABS independent sessions), header actions on the right (C4 / design ref).
    const tabsRow = composer.createDiv({ cls: "agentic-chat-tabs-row" });
    this.tabsEl = tabsRow.createDiv({ cls: "agentic-chat-tabs", attr: { role: "tablist" } });
    const headerActions = tabsRow.createDiv({ cls: "agentic-chat-tab-actions" });
    const newChatButton = headerActions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "New chat" },
    });
    setIcon(newChatButton, "square-pen");
    newChatButton.addEventListener("click", () => void this.newSession());
    const historyButton = headerActions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "Conversation history" },
    });
    setIcon(historyButton, "history");
    historyButton.addEventListener("click", () => void this.openSessionList());

    // The single bordered input card: context row (chips) + textarea + bottom toolbar
    // all live *inside* one rectangle, instead of stacked around a bordered textarea.
    const field = composer.createDiv({ cls: "agentic-chat-field" });
    this.chipsEl = field.createDiv({ cls: "agentic-chat-chips" });

    const inputWrap = field.createDiv({ cls: "agentic-chat-input-wrap" });
    this.inputEl = inputWrap.createEl("textarea", {
      cls: "agentic-chat-input",
      attr: { rows: "3", placeholder: "Ask about your vault — / for commands, @ to attach a note… (Enter to send)" },
    });
    this.menu = new AutocompleteMenu(inputWrap, (item) => this.chooseAutocomplete(item));
    this.inputEl.addEventListener("keydown", (event) => {
      if (this.menu.handleKey(event)) return;
      if (event.key === "Escape" && this.promptEdit.isEditing) {
        event.preventDefault();
        this.cancelEditing();
        return;
      }
      if (event.key === "ArrowUp" && this.recallHistory(-1)) {
        event.preventDefault();
        return;
      }
      if (event.key === "ArrowDown" && this.recallHistory(1)) {
        event.preventDefault();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.submit();
      }
    });
    // Real user typing both refreshes autocomplete and abandons history navigation.
    // Programmatic value changes (recall) set `.value` directly without an input event.
    this.inputEl.addEventListener("input", () => {
      this.resetHistoryNav();
      this.scheduleAutocomplete();
    });
    this.inputEl.addEventListener("click", () => this.scheduleAutocomplete());
    this.inputEl.addEventListener("keyup", (event) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) this.scheduleAutocomplete();
    });
    this.inputEl.addEventListener("blur", () => {
      this.cancelAutocomplete();
      this.menu.hide();
    });

    // Bottom toolbar (in-card): model · effort · context · folder-context on the
    // left; the Safe ↔ YOLO toggle (+ sticky plan badge) on the right — design ref.
    const toolbar = field.createDiv({ cls: "agentic-chat-toolbar" });
    const toolbarLeft = toolbar.createDiv({ cls: "agentic-chat-toolbar-left" });

    this.modelPillEl = toolbarLeft.createDiv({
      cls: "agentic-chat-model-pill",
      attr: { "aria-label": "Switch model" },
    });
    this.modelPillEl.addEventListener("click", () => void this.switchModel());

    // Effort knob: click cycles the reasoning level for the next message only.
    this.effortKnobEl = toolbarLeft.createDiv({
      cls: "agentic-chat-effort",
      attr: { role: "button", tabindex: "0" },
    });
    this.effortKnobEl.addEventListener("click", () => this.cycleEffort());
    this.effortKnobEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.cycleEffort();
      }
    });

    this.contextBarEl = toolbarLeft.createEl("progress", {
      cls: "agentic-chat-ctx-bar",
      attr: { "aria-label": "Context window used", max: "100", value: "0" },
    });
    this.contextPercentEl = toolbarLeft.createSpan({ cls: "agentic-chat-ctx-percent" });
    this.contextBarEl.hide();
    this.contextPercentEl.hide();

    // Folder affordance ("dir. context"): grant a working directory (auto-run inside,
    // ask outside) or attach a one-off folder listing as context. (C1)
    this.folderButtonEl = toolbarLeft.createEl("button", {
      cls: "agentic-chat-attach",
      attr: { "aria-label": "Folders: working directory or attach listing" },
    });
    setIcon(this.folderButtonEl, "folder");
    this.folderButtonEl.addEventListener("click", () => this.showFolderMenu());

    const toolbarRight = toolbar.createDiv({ cls: "agentic-chat-toolbar-right" });
    // Single Safe ↔ YOLO permission toggle (the ask/plan/agent dropdown is retired).
    this.modeToggleEl = toolbarRight.createDiv({
      cls: "agentic-chat-mode-toggle",
      attr: { role: "group", "aria-label": "Permission mode" },
    });
    this.safeButtonEl = this.buildModeSegment(this.modeToggleEl, "safe");
    this.yoloButtonEl = this.buildModeSegment(this.modeToggleEl, "yolo");
    // Plan is sticky (/plan…/endplan); show a clear indicator while it's active.
    this.planBadgeEl = toolbarRight.createDiv({
      cls: "agentic-chat-plan-badge",
      attr: { "aria-label": "Plan mode active — read-only. Click or /endplan to exit." },
    });
    const planIcon = this.planBadgeEl.createSpan({ cls: "agentic-chat-plan-badge-icon" });
    setIcon(planIcon, MODES.plan.icon);
    this.planBadgeEl.createSpan({ text: "Plan" });
    this.planBadgeEl.addEventListener("click", () => void this.exitPlanMode());
    this.planBadgeEl.hide();
    // Output style is no longer a composer control — switch it with /style.

    const buttonRow = composer.createDiv({ cls: "agentic-chat-buttons" });
    this.workingEl = buttonRow.createDiv({ cls: "agentic-chat-working", attr: { "aria-hidden": "true" } });
    this.workingEl.hide();
    this.statusEl = buttonRow.createDiv({ cls: "agentic-chat-status" });
    this.stopButton = buttonRow.createEl("button", { cls: ["agentic-chat-stop", "mod-warning"], text: "Stop" });
    this.stopButton.hide();
    this.stopButton.addEventListener("click", () => this.service.abort());
    this.sendButton = buttonRow.createEl("button", { cls: ["agentic-chat-send", "mod-cta"], text: "Send" });
    this.sendButton.addEventListener("click", () => void this.submit());

    // Token/cost readout on its own muted line; hidden until there's usage.
    this.usageEl = composer.createDiv({ cls: "agentic-chat-usage" });

    // Dragging a note onto the composer should attach it as context, not open it.
    this.registerDomEvent(composer, "dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    this.registerDomEvent(composer, "drop", (event) => this.handleDrop(event));
  }

  /**
   * Turn dropped notes/folders into context attachments instead of opening them.
   * Multi-select drops are supported — every dragged entry attaches at once. Only
   * real vault entries are intercepted; otherwise the drop falls through to Obsidian.
   */
  private handleDrop(event: DragEvent): void {
    const entries = this.resolveDroppedEntries(event);
    if (!entries.length) return;
    event.preventDefault();
    event.stopPropagation();
    // Count vision-blocked images across the whole batch so we post one aggregated
    // notice instead of one toast per file (the single-entry addAttachment path
    // still self-notifies for non-drop attachers).
    let skippedImages = 0;
    for (const entry of entries) {
      const path = entry instanceof TFolder ? `${FOLDER_PREFIX}${entry.path}` : entry.path;
      if (isImagePath(path) && !this.service.supportsImages()) {
        skippedImages++;
        continue;
      }
      this.pushAttachment(path);
    }
    if (skippedImages > 0) {
      new Notice(
        skippedImages === 1
          ? "This model can't read images. Switch to a vision model to attach images."
          : `${skippedImages} images skipped — this model can't read images. Switch to a vision model.`,
      );
    }
  }

  /**
   * Resolve a drop to the vault files/folders it carries. Obsidian's file-explorer
   * and editor drags no longer put an `obsidian://` URL on the dataTransfer, so we
   * first ask the internal drag manager for the entries being dragged (a single
   * `file` or a multi-select `files` array), then fall back to parsing a path/URL
   * out of the drop payload (external or older drags, single entry only).
   */
  private resolveDroppedEntries(event: DragEvent): Array<TFile | TFolder> {
    const dragManager = (this.app as unknown as { dragManager?: ObsidianDragManager }).dragManager;
    const dragged = dragManager?.draggable;
    const candidates: unknown[] = [];
    if (dragged?.file) candidates.push(dragged.file);
    if (Array.isArray(dragged?.files)) candidates.push(...dragged.files);
    const fromDrag = candidates.filter(
      (entry): entry is TFile | TFolder => entry instanceof TFile || entry instanceof TFolder,
    );
    if (fromDrag.length) return fromDrag;

    const data =
      event.dataTransfer?.getData("text/plain") || event.dataTransfer?.getData("text/uri-list") || "";
    const path = parseDroppedVaultPath(data, this.app.vault.getName());
    if (!path) return [];
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile || file instanceof TFolder ? [file] : [];
  }

  private renderEmptyState(): void {
    this.emptyStateEl = this.messagesEl.createDiv({ cls: "agentic-chat-empty" });
    const icon = this.emptyStateEl.createDiv({ cls: "agentic-chat-empty-icon" });
    setIcon(icon, "bot");
    this.emptyStateEl.createDiv({
      cls: "agentic-chat-empty-text",
      text: "Ask anything about your vault. The agent can read, search, write, and edit notes — every tool call is shown inline. Type / for commands or @ to attach a note.",
    });
  }

  private clearEmptyState(): void {
    this.emptyStateEl?.detach();
    this.emptyStateEl = null;
  }

  // --- autocomplete (slash commands, skills, @-mentions) ---

  private autocompleteTimer: number | null = null;

  /**
   * Debounced recompute for typing/caret events, so a fast typist (or a large
   * vault's mention scan) doesn't re-filter on every keystroke. Picking an item
   * calls {@link updateAutocomplete} directly for an instant reopen.
   */
  private scheduleAutocomplete(): void {
    this.cancelAutocomplete();
    this.autocompleteTimer = window.setTimeout(() => {
      this.autocompleteTimer = null;
      this.updateAutocomplete();
    }, 120);
  }

  private cancelAutocomplete(): void {
    if (this.autocompleteTimer !== null) {
      window.clearTimeout(this.autocompleteTimer);
      this.autocompleteTimer = null;
    }
  }

  private updateAutocomplete(): void {
    if (this.service.isStreaming()) {
      this.menu.hide();
      return;
    }
    const text = this.inputEl.value;
    const caret = this.inputEl.selectionStart ?? text.length;
    const query = detectQuery(text, caret);
    if (!query) {
      this.activeQuery = null;
      this.menu.hide();
      return;
    }
    this.activeQuery = query;
    this.menu.show(
      suggest(query, {
        commands: visibleCommands(),
        skills: this.service.getSkills(),
        files: query.kind === "mention" ? this.mentionCandidates() : [],
      }),
    );
  }

  private chooseAutocomplete(item: AcItem): void {
    if (!this.activeQuery) return;
    const result = resolve(this.inputEl.value, this.activeQuery, item);
    this.inputEl.value = result.text;
    this.inputEl.setSelectionRange(result.caret, result.caret);
    this.inputEl.focus();
    if (result.attach) this.addAttachment(result.attach);
    this.activeQuery = null;
    // Re-evaluate so e.g. completing "/skill " immediately offers the skill list.
    this.updateAutocomplete();
  }

  /** All notes and folders as mention candidates, cached until the vault changes. */
  private mentionCandidates(): MentionCandidate[] {
    if (this.mentionCache) return this.mentionCache;
    const candidates: MentionCandidate[] = [];
    for (const file of this.app.vault.getAllLoadedFiles()) {
      if (file instanceof TFolder) {
        if (file.path && file.path !== "/") candidates.push({ path: file.path, type: "folder" });
      } else if (file instanceof TFile) {
        candidates.push({ path: file.path, type: "file", name: file.basename });
      }
    }
    this.mentionCache = candidates;
    return candidates;
  }

  // --- composer controls (Safe ↔ YOLO toggle + sticky plan) ---

  /** One segment of the Safe ↔ YOLO toggle. */
  private buildModeSegment(parent: HTMLElement, mode: "safe" | "yolo"): HTMLButtonElement {
    const button = parent.createEl("button", {
      cls: "agentic-chat-mode-seg",
      text: MODES[mode].label,
      attr: { "aria-label": MODES[mode].description, title: MODES[mode].description },
    });
    button.addEventListener("click", () => void this.setMode(mode));
    return button;
  }

  private async setMode(mode: AgentMode): Promise<void> {
    // Mode is evaluated live by the tool gate; changing it mid-stream would
    // disagree with the system prompt this run started under. Lock it while busy.
    if (this.service.isStreaming()) return;
    if (this.plugin.settings.mode === mode) return;
    this.plugin.settings.mode = mode;
    // Choosing a posture other than plan ends any sticky plan state.
    if (mode !== "plan") this.modeBeforePlan = null;
    await this.plugin.saveSettings();
    this.syncControls();
  }

  /** `/plan`: enter sticky read-only plan mode, remembering the posture to restore. */
  private async enterPlanMode(): Promise<void> {
    this.clearEmptyState();
    if (this.service.isStreaming()) {
      this.renderErrorMessage("Can't switch mode while the agent is responding.");
      return;
    }
    const transition = enterPlan(this.plugin.settings.mode);
    if (!transition) {
      this.renderInfoMessage("Plan", [["Plan", "Already in plan mode. Use /endplan to leave."]]);
      return;
    }
    this.modeBeforePlan = transition.previous;
    await this.setMode("plan");
    this.renderInfoMessage("Plan", [[MODES.plan.label, MODES.plan.description]]);
  }

  /** `/endplan`: leave plan mode, restoring the Safe/YOLO posture in effect before /plan. */
  private async exitPlanMode(): Promise<void> {
    this.clearEmptyState();
    if (this.plugin.settings.mode !== "plan") {
      this.renderInfoMessage("Plan", [["Plan", "Not in plan mode."]]);
      return;
    }
    if (this.service.isStreaming()) {
      this.renderErrorMessage("Can't switch mode while the agent is responding.");
      return;
    }
    const restored = exitPlan(this.modeBeforePlan);
    this.modeBeforePlan = null;
    await this.setMode(restored);
    this.renderInfoMessage("Mode", [[MODES[restored].label, MODES[restored].description]]);
  }

  private async setOutputStyle(style: OutputStyle): Promise<void> {
    if (this.service.isStreaming()) return;
    if (this.plugin.settings.outputStyle === style) return;
    this.plugin.settings.outputStyle = style;
    await this.plugin.saveSettings();
    this.syncControls();
  }

  /**
   * Reflect settings (e.g. changed via /config, /plan, or the settings tab) back into
   * the composer toggle, and disable it while the agent is streaming or in plan mode so
   * the posture can't drift from the prompt/policy the in-flight turn started under.
   */
  private syncControls(): void {
    if (!this.modeToggleEl) return;
    const { settings } = this.plugin;
    const streaming = this.service.isStreaming();
    const planning = settings.mode === "plan";
    this.safeButtonEl.toggleClass("is-active", settings.mode === "safe");
    this.yoloButtonEl.toggleClass("is-active", settings.mode === "yolo");
    this.safeButtonEl.disabled = streaming || planning;
    this.yoloButtonEl.disabled = streaming || planning;
    this.modeToggleEl.toggleClass("is-planning", planning);
    this.planBadgeEl.toggle(planning);
    // Effort can't change mid-turn (it would disagree with the in-flight request).
    this.effortKnobEl?.toggleClass("is-disabled", streaming);
  }

  // --- chrome (header pill, usage, running state) ---

  private syncChrome(): void {
    const { settings } = this.plugin;
    this.syncControls();
    this.modelPillEl.empty();
    const override = this.service.getModelOverride();
    const providerLabel = override ? "next only" : modelProviderLabel(settings.provider);
    const fullModel = override ?? activeModelId(settings);
    this.modelPillEl.toggleClass("is-override", !!override);
    // Full slug in the tooltip; the pill shows a short label since OpenRouter ids are long.
    this.modelPillEl.setAttr("title", `${providerLabel} · ${fullModel}`);
    this.modelPillEl.createSpan({ cls: "agentic-chat-model-provider", text: providerLabel });
    this.modelPillEl.createSpan({ cls: "agentic-chat-model-name", text: shortModelLabel(fullModel) });
    this.syncEffortKnob();
    this.syncFolderButton(settings.approval.workingDirs.length);

    const usage = this.service.getSessionUsage();
    const fraction = this.service.getContextFraction();
    const parts: string[] = [];
    if (usage.totalTokens > 0) parts.push(formatUsage(usage));
    // Pre-send estimate of what the next request will cost (priced models only).
    const estimate = this.service.estimateNextCost();
    if (estimate && estimate.usd > 0) parts.push(`next ~${formatCost(estimate.usd)}`);
    this.usageEl.setText(parts.join(" · "));
    this.syncContextBar(fraction);

    const error = this.service.getError();
    this.setRunning(this.service.isStreaming());
    if (error && !this.service.isStreaming()) this.statusEl.setText("");
    this.checkUsageNotifications();
  }

  /** Accent the folder button while working dirs are granted, and surface the count. */
  private syncFolderButton(scopeCount: number): void {
    if (!this.folderButtonEl) return;
    this.folderButtonEl.toggleClass("has-scope", scopeCount > 0);
    this.folderButtonEl.setAttr(
      "aria-label",
      scopeCount > 0
        ? `Folders · ${scopeCount} working ${scopeCount === 1 ? "directory" : "directories"} granted`
        : "Folders: working directory or attach listing",
    );
  }

  /** Glanceable color-coded context-window fill bar; hidden until usage is known. */
  private syncContextBar(fraction: number | undefined): void {
    if (fraction === undefined) {
      this.contextBarEl.hide();
      this.contextPercentEl.hide();
      return;
    }
    const percent = contextPercent(fraction);
    this.contextBarEl.show();
    this.contextPercentEl.show();
    this.contextBarEl.setAttr("aria-label", `Context window ${percent}% used`);
    this.contextBarEl.value = percent;
    // Drive the CSS arc/gauge fill (conic-gradient ring) off the same percent
    // the helpers already compute — no new logic, just expose it to the style.
    this.contextBarEl.style.setProperty("--ctx-pct", String(percent));
    this.contextBarEl.removeClasses(["is-ok", "is-warn", "is-high"]);
    this.contextBarEl.addClass(`is-${contextLevel(fraction)}`);
    this.contextPercentEl.setText(`${percent}%`);
    this.contextPercentEl.removeClasses(["is-ok", "is-warn", "is-high"]);
    this.contextPercentEl.addClass(`is-${contextLevel(fraction)}`);
  }

  /** Fire one-shot background toasts as the context window fills or cost crosses the cap. */
  private checkUsageNotifications(): void {
    if (this.muteNotifications) return;
    const compactions = this.service.getCompactionCount();
    if (compactions > this.lastCompactionCount) {
      this.lastCompactionCount = compactions;
      // The window just freed up; re-arm the fill warnings for the next climb.
      this.notifiedContext = new Set<number>();
      this.notifier.notify("contextWindow", "Compacted earlier turns to free up context.");
    }
    const fraction = this.service.getContextFraction();
    if (fraction !== undefined) {
      const crossed = highestUnnotifiedThreshold(fraction, CONTEXT_THRESHOLDS, this.notifiedContext);
      if (crossed !== null) {
        this.notifiedContext.add(crossed);
        this.notifier.notify("contextWindow", `Context window ${Math.round(crossed * 100)}% full — consider /new soon.`);
      }
    }
    const cap = this.plugin.settings.notifications.costAlertUsd;
    if (cap > 0 && !this.notifiedCost) {
      const cost = this.service.getSessionUsage().cost?.total ?? 0;
      if (cost >= cap) {
        this.notifiedCost = true;
        this.notifier.notify("cost", `This conversation has cost $${cost.toFixed(2)} (alert set at $${cap.toFixed(2)}).`);
      }
    }
  }

  /** Notify when a turn finishes while the user is working elsewhere. */
  private notifyTurnComplete(): void {
    if (this.app.workspace.getActiveViewOfType(ChatView) === this) return;
    this.notifier.notify("agentFinished", "Agentic chat finished responding.");
  }

  private setRunning(running: boolean): void {
    this.sendButton.disabled = running;
    if (running) {
      this.stopButton.show();
      this.workingEl.show();
    } else {
      this.stopButton.hide();
      this.workingEl.hide();
      this.statusEl.setText("");
    }
  }

  // --- submission + slash commands ---

  private async submit(): Promise<void> {
    if (this.service.isStreaming()) return;
    this.cancelAutocomplete();
    this.menu.hide();
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.pushHistory(text);

    const editIndex = this.promptEdit.index;
    this.endEditing(false);

    if (text.startsWith("/")) {
      const handled = await this.handleSlashCommand(text);
      if (handled) {
        this.inputEl.value = "";
        return;
      }
    }
    this.inputEl.value = "";
    if (editIndex !== null) {
      await this.editAndResend(editIndex, text);
      return;
    }
    await this.sendPrompt(text);
  }

  // --- prompt editing (rewrite a sent user turn) ---

  /** Load a sent prompt back into the composer for rewriting. */
  private beginEdit(index: number, displayText: string, el: HTMLElement): void {
    if (this.service.isStreaming()) return;
    // Re-clicking the turn already being edited must not reset the composer and
    // discard the user's in-progress changes.
    const edit = this.promptEdit.begin(index, this.inputEl.value);
    if (!edit.started) return;
    this.clearEditingHighlight();
    this.editingEl = el;
    el.addClass("is-editing");
    this.setComposerValue(displayText);
    this.inputEl.focus();
    this.inputEl.setSelectionRange(displayText.length, displayText.length);
    this.statusEl.setText("Editing — Enter to resend, Esc to cancel");
  }

  /** Cancel an in-progress edit, restoring the draft the user had before editing. */
  private cancelEditing(): void {
    this.endEditing(true);
  }

  /** Clear editing state. `restoreDraft` puts back the pre-edit composer draft. */
  private endEditing(restoreDraft: boolean): void {
    const edit = this.promptEdit.end(restoreDraft);
    if (!edit.ended) return;
    this.clearEditingHighlight();
    if (edit.draftToRestore !== null) this.setComposerValue(edit.draftToRestore);
    this.statusEl.setText("");
  }

  /** Set the composer text and notify input listeners (autocomplete) of the change. */
  private setComposerValue(value: string): void {
    this.inputEl.value = value;
    this.inputEl.dispatchEvent(new Event("input"));
  }

  // --- command history (shell-style up/down recall) ---

  /** Record a submitted message, skipping consecutive duplicates, then reset navigation. */
  private pushHistory(text: string): void {
    this.composerHistory.record(text);
  }

  private resetHistoryNav(): void {
    this.composerHistory.resetNavigation();
  }

  /**
   * Cycle the composer through sent-message history. `direction` is -1 (older,
   * ArrowUp) or +1 (newer, ArrowDown). Only acts when the caret is on the edge
   * line in that direction, so arrow keys still move within a multi-line draft.
   * Returns true when it consumed the key.
   */
  private recallHistory(direction: -1 | 1): boolean {
    if (this.promptEdit.isEditing) return false;
    const result = this.composerHistory.recall(direction, {
      value: this.inputEl.value,
      selectionStart: this.inputEl.selectionStart,
      selectionEnd: this.inputEl.selectionEnd,
    });
    if (!result.handled) return false;
    if (result.value !== undefined) this.setComposerValueQuiet(result.value);
    return true;
  }

  /**
   * Set the composer value WITHOUT dispatching an input event, so history recall
   * doesn't reset its own navigation state. Places the caret at the end and hides
   * the autocomplete menu.
   */
  private setComposerValueQuiet(value: string): void {
    this.inputEl.value = value;
    this.inputEl.setSelectionRange(value.length, value.length);
    this.menu.hide();
  }

  private clearEditingHighlight(): void {
    this.editingEl?.removeClass("is-editing");
    this.editingEl = null;
  }

  /** Rewind to `index`, drop that turn and everything after, then send the edit. */
  private async editAndResend(index: number, text: string): Promise<void> {
    try {
      await this.service.truncateMessages(index);
    } catch (error) {
      // A failed session rewrite must not silently swallow the edit.
      this.renderErrorMessage(error instanceof Error ? error.message : String(error));
      return;
    }
    this.bubble = null;
    this.renderTranscript(this.service.getMessages());
    await this.sendPrompt(text);
  }

  private async sendPrompt(text: string): Promise<void> {
    this.clearEmptyState();
    // Show the auto-attached active note alongside explicit attachments in the user bubble.
    const autoPath = this.effectiveActiveNote();
    const attachments = [...(autoPath ? [autoPath] : []), ...this.attachments];
    const context = await this.buildContext();
    const prompt = context ? `${context}\n\n${text}` : text;
    // Image attachments ride as multimodal content parts, not text context.
    const images = await this.loadImageAttachments();
    this.lastSentPrompt = prompt;
    this.lastSentDisplay = text;
    this.renderUserMessage(text, attachments);
    await this.service.sendPrompt(prompt, images);
    this.showServiceError();
  }

  /** Encode image attachments as multimodal content parts for the model. */
  private async loadImageAttachments(): Promise<ImageContent[]> {
    return await loadContextImageAttachments({
      app: this.app,
      attachments: this.attachments,
      supportsImages: this.service.supportsImages(),
    });
  }

  /** Re-run the conversation's last user turn (inline "Ask again" action). */
  private async retryLast(): Promise<void> {
    if (this.service.isStreaming()) return;
    const prompt = this.lastSentPrompt ?? lastUserText(this.service.getMessages());
    if (!prompt) return;
    const display = this.lastSentDisplay ?? stripContextPreamble(prompt);
    this.clearEmptyState();
    this.renderUserMessage(display, []);
    await this.service.sendPrompt(prompt);
    this.showServiceError();
  }

  private async handleSlashCommand(raw: string): Promise<boolean> {
    const [word, ...rest] = raw.slice(1).split(/\s+/);
    const argString = raw.slice(1 + word.length).trim();
    const command = resolveCommand(word);
    if (!command) {
      // A bare /<skill-name> runs that skill directly (built-in commands take
      // precedence — a shadowed skill stays reachable via /skill <name>).
      const skill = this.service.getSkills().find((item) => item.name.toLowerCase() === word.toLowerCase());
      if (skill) {
        await this.runSkill(skill.name, argString, `/${word}${argString ? ` ${argString}` : ""}`);
        return true;
      }
      return false;
    }
    switch (command.name) {
      case "new":
        await this.newSession();
        return true;
      case "style":
        await this.runStyle(argString);
        return true;
      case "effort":
        this.runEffort(argString);
        return true;
      case "sessions":
        await this.openSessionList();
        return true;
      case "model":
        await this.switchModel();
        return true;
      case "status":
        this.showStatus();
        return true;
      case "diagnostics":
        this.showDiagnostics();
        return true;
      case "config":
        this.showConfig();
        return true;
      case "add-dir":
        await this.runAddDir(argString);
        return true;
      case "dirs":
        this.showWorkingDirs();
        return true;
      case "plan":
        await this.enterPlanMode();
        return true;
      case "endplan":
        await this.exitPlanMode();
        return true;
      case "usage":
        this.showUsage();
        return true;
      case "export":
        await this.exportSession();
        return true;
      case "undo":
        await this.runUndo();
        return true;
      case "skill":
        await this.runSkill(rest[0], argString.slice(rest[0]?.length ?? 0).trim());
        return true;
      case "agent":
        await this.runAgent(rest[0], argString.slice(rest[0]?.length ?? 0).trim());
        return true;
      case "init":
        await this.runInit();
        return true;
      case "template":
        await this.runTemplate(rest[0], rest.slice(1));
        return true;
      case "help":
        this.showHelp();
        return true;
      default:
        return false;
    }
  }

  private async runSkill(name: string | undefined, extra: string, display?: string): Promise<void> {
    if (!name) {
      this.showSkillList();
      return;
    }
    this.clearEmptyState();
    this.renderUserMessage(display ?? `/skill ${name}${extra ? ` ${extra}` : ""}`, []);
    await this.service.invokeSkill(name, extra || undefined);
    this.showServiceError();
  }

  /** `/init`: drive the agent to curate the vault's AGENTS.md standing-instructions file. */
  private async runInit(): Promise<void> {
    this.clearEmptyState();
    this.renderUserMessage("/init", []);
    await this.service.invokeInit();
    this.showServiceError();
  }

  /** `/style [name]`: no arg shows a picker; an arg switches output style directly. */
  private async runStyle(arg: string): Promise<void> {
    this.clearEmptyState();
    if (!arg) {
      this.showStyleList();
      return;
    }
    const lower = arg.toLowerCase();
    const style = OUTPUT_STYLE_ORDER.find((id) => id === lower || OUTPUT_STYLES[id].label.toLowerCase() === lower);
    if (!style) {
      this.renderErrorMessage(`Unknown output style "${arg}". Options: ${OUTPUT_STYLE_ORDER.join(", ")}.`);
      return;
    }
    await this.chooseStyle(style);
  }

  /** Clickable output-style picker, applied in-pane. */
  private showStyleList(): void {
    const { settings } = this.plugin;
    this.renderActionList(
      "Output style",
      `How the assistant talks · current: ${OUTPUT_STYLES[settings.outputStyle].label}`,
      OUTPUT_STYLE_ORDER.map((id) => ({
        label: OUTPUT_STYLES[id].label,
        detail: OUTPUT_STYLES[id].description,
        icon: OUTPUT_STYLES[id].icon,
        onClick: () => void this.chooseStyle(id),
      })),
    );
  }

  /** `/effort [level]`: no arg shows a picker; an arg sets the next message's reasoning effort. */
  private runEffort(arg: string): void {
    this.clearEmptyState();
    if (!arg) {
      this.showEffortList();
      return;
    }
    const lower = arg.toLowerCase();
    const levels = this.service.getActiveThinkingLevels();
    const level = levels.find((id) => id === lower);
    if (!level) {
      this.renderErrorMessage(`Unknown or unsupported effort "${arg}". Options: ${levels.join(", ")}.`);
      return;
    }
    this.chooseEffort(level);
  }

  /** Clickable effort picker. The subtitle warns that switching costs a one-time cache miss. */
  private showEffortList(): void {
    const current = this.service.getActiveThinkingLevel();
    const levels = this.service.getActiveThinkingLevels();
    this.renderActionList(
      "Effort",
      `Reasoning effort for your next message · current: ${current}. ` +
        "Changing it re-processes the prompt once (a cache miss) — affects cost.",
      levels.map((id) => ({
        label: id,
        detail: id === current ? "current" : "",
        icon: "gauge",
        onClick: () => this.chooseEffort(id),
      })),
    );
  }

  /** Apply a one-shot effort override for the next message only (reverts to the saved default). */
  private chooseEffort(level: ThinkingLevel): void {
    if (this.service.isStreaming()) {
      this.renderErrorMessage("Can't change effort while the agent is responding.");
      return;
    }
    this.service.setThinkingOverride(level);
    this.renderInfoMessage("Effort", [
      [level, "Applies to your next message only, then reverts to the saved default."],
    ]);
  }

  /** Composer effort knob: cycle to the next supported reasoning level for the next message only. */
  private cycleEffort(): void {
    if (this.service.isStreaming()) return;
    const levels = this.service.getActiveThinkingLevels();
    const current = this.service.getActiveThinkingLevel();
    const base = levels.length > 0 ? levels : THINKING_LEVELS;
    const index = base.indexOf(current);
    const next = base[(index + 1) % base.length];
    // setThinkingOverride notifies, so syncChrome re-renders the knob.
    this.service.setThinkingOverride(next);
  }

  /** Render the composer effort knob from the level the next message will use. */
  private syncEffortKnob(): void {
    if (!this.effortKnobEl) return;
    const level = this.service.getActiveThinkingLevel();
    const overridden = this.service.getThinkingOverride() !== null;
    this.effortKnobEl.empty();
    this.effortKnobEl.createSpan({ cls: "agentic-chat-effort-label", text: "Effort" });
    this.effortKnobEl.createSpan({ cls: "agentic-chat-effort-value", text: level });
    this.effortKnobEl.toggleClass("is-override", overridden);
    const hint =
      `Reasoning effort for your next message: ${level}. Click to change. ` +
      "Switching effort re-processes the prompt once (a cache miss) — affects cost.";
    this.effortKnobEl.setAttr("title", hint);
    this.effortKnobEl.setAttr("aria-label", hint);
  }

  /** `/skill` with no argument: a clickable picker, not a static list. */
  private showSkillList(): void {
    const skills = this.service.getSkills();
    this.clearEmptyState();
    if (skills.length === 0) {
      this.renderInfoMessage("Skills", [["(none)", "Set a skills folder in settings to add skills."]]);
      return;
    }
    this.renderActionList(
      "Skills",
      "Pick a skill to run.",
      skills.map((skill) => ({
        label: skill.name,
        detail: skill.description,
        icon: "sparkles",
        onClick: () => void this.runSkill(skill.name, ""),
      })),
    );
  }

  private async runAgent(name: string | undefined, task: string): Promise<void> {
    if (!name) {
      this.showAgentList();
      return;
    }
    this.clearEmptyState();
    this.renderUserMessage(`/agent ${name}${task ? ` ${task}` : ""}`, []);
    await this.service.invokeAgent(name, task);
    this.showServiceError();
  }

  /** `/agent` with no argument: a clickable picker that prefills the composer. */
  private showAgentList(): void {
    const profiles = this.service.getProfiles();
    this.clearEmptyState();
    if (profiles.length === 0) {
      this.renderInfoMessage("Subagents", [
        ["(none)", "Enable built-in subagents or set a subagents folder in settings."],
      ]);
      return;
    }
    this.renderActionList(
      "Subagents",
      "Pick a subagent, then type its task.",
      profiles.map((profile) => ({
        label: profile.name,
        detail: profile.description,
        icon: "bot",
        onClick: () => this.prefillComposer(`/agent ${profile.name} `),
      })),
    );
  }

  private prefillComposer(text: string): void {
    // setComposerValue dispatches the "input" event so autocomplete/composer
    // state stays in sync (a bare `.value =` would not).
    this.setComposerValue(text);
    this.inputEl.focus();
    this.inputEl.setSelectionRange(text.length, text.length);
  }

  /** `/template` is retired: templates are now skills (with $ARGUMENTS support). */
  private async runTemplate(name: string | undefined, args: string[]): Promise<void> {
    this.clearEmptyState();
    this.renderInfoMessage("Deprecated", [
      ["/template", "is now /skill — templates load as skills with $ARGUMENTS/$1 support."],
    ]);
    if (!name) {
      this.showSkillList();
      return;
    }
    await this.runSkill(name, args.join(" "));
  }

  private showStatus(): void {
    const { settings } = this.plugin;
    const session = this.service.getSessionInfo();
    const override = this.service.getModelOverride();
    const effortOverride = this.service.getThinkingOverride();
    const diagnostics = this.service.getRuntimeDiagnostics();
    this.clearEmptyState();
    this.renderInfoMessage("Status", [
      ["Provider", settings.provider],
      ["Model", override ? `${override} (next message only)` : activeModelId(settings)],
      ["Mode", MODES[settings.mode].label],
      ["Output style", OUTPUT_STYLES[settings.outputStyle].label],
      ["Thinking", effortOverride ? `${effortOverride} (next message only)` : settings.thinkingLevel],
      ["Approval (mutating)", settings.approval.mutating],
      ["Session", session ? `${session.messageCount} messages` : "(none)"],
      ["MCP", formatMcpDiagnosticSummary(diagnostics.resources.mcpServers)],
      ...formatMcpDiagnosticRows(diagnostics.resources.mcpServers),
    ]);
  }

  private showDiagnostics(): void {
    this.clearEmptyState();
    this.renderInfoMessage("Diagnostics", formatRuntimeDiagnosticsRows(this.service.getRuntimeDiagnostics()));
  }

  /** `/config`: clickable mode picker, applied in-pane. Output style lives under /style. */
  private showConfig(): void {
    const { settings } = this.plugin;
    this.clearEmptyState();
    this.renderActionList(
      "Mode",
      `What the agent may do · current: ${MODES[settings.mode].label}`,
      MODE_ORDER.map((id) => ({
        label: MODES[id].label,
        detail: MODES[id].description,
        icon: MODES[id].icon,
        onClick: () => void this.chooseMode(id),
      })),
    );
  }

  private async chooseMode(mode: AgentMode): Promise<void> {
    // Plan is sticky: route it through enterPlanMode so /endplan can restore the posture.
    if (mode === "plan") {
      await this.enterPlanMode();
      return;
    }
    await this.setMode(mode);
    this.renderInfoMessage("Mode", [[MODES[mode].label, MODES[mode].description]]);
  }

  private async chooseStyle(style: OutputStyle): Promise<void> {
    await this.setOutputStyle(style);
    this.renderInfoMessage("Output style", [[OUTPUT_STYLES[style].label, OUTPUT_STYLES[style].description]]);
  }

  /** `/undo`: revert the agent's most recent vault change, reported in-pane. */
  private async runUndo(): Promise<void> {
    this.clearEmptyState();
    const result = await this.service.undoLastChange();
    this.renderInfoMessage("Undo", [["result", result]]);
  }

  private showUsage(): void {
    const usage = this.service.getSessionUsage();
    this.clearEmptyState();
    // Build the rows as a tuple array (renderInfoMessage wants [string, string][]),
    // inserting the cache row only once a cached prompt has shown up.
    const rows: Array<[string, string]> = [
      ["Tokens", String(usage.totalTokens)],
      ["Cost", formatCost(usage.cost?.total ?? 0)],
    ];
    const cacheHit = cacheHitPercent(usage);
    if (cacheHit !== null) rows.splice(1, 0, ["Cache", `${cacheHit}% prompt-cache hit`]);
    this.renderInfoMessage(
      "Usage",
      usage.totalTokens > 0 ? rows : [["Usage", "No usage recorded yet for this conversation."]],
    );
  }

  /** `/export`: write the active conversation to a Markdown note and open it. */
  private async exportSession(): Promise<void> {
    this.clearEmptyState();
    const messages = this.service.getMessages();
    if (!hasExportableTurns(messages)) {
      this.renderInfoMessage("Export", [["Export", "Nothing to export yet — send a message first."]]);
      return;
    }
    try {
      const markdown = sessionToMarkdown(messages, this.service.getSessionInfo());
      // getAbstractFileByPath (not getFolderByPath, which needs Obsidian ≥1.5.3) so
      // the folder check works down to the manifest's minAppVersion.
      if (!this.app.vault.getAbstractFileByPath(EXPORT_FOLDER)) {
        await this.app.vault.createFolder(EXPORT_FOLDER);
      }
      const path = `${EXPORT_FOLDER}/${exportFileName(this.service.getSessionInfo(), Date.now())}`;
      const file = await this.app.vault.create(path, markdown);
      await this.app.workspace.getLeaf(false).openFile(file);
      this.renderInfoMessage("Export", [["Saved", file.path]]);
    } catch (error) {
      this.renderErrorMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private showHelp(): void {
    this.clearEmptyState();
    this.renderInfoMessage(
      "Slash commands",
      visibleCommands().map((command): [string, string] => [
        `/${command.name}${command.args ? ` ${command.args}` : ""}`,
        command.description,
      ]),
    );
  }

  /** Render a collapsible info block in the transcript (not sent to the model). */
  private renderInfoMessage(title: string, entries: Array<[string, string]>): void {
    const el = this.messagesEl.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info"] });
    const details = el.createEl("details", { cls: "agentic-chat-info-details" });
    details.open = true;
    details.createEl("summary", { text: title });
    const list = details.createEl("ul", { cls: ["agentic-chat-info-body", "agentic-chat-info-list"] });
    for (const [label, value] of entries) {
      const item = list.createEl("li");
      item.createEl("code", { text: label });
      item.appendText(` — ${value}`);
    }
    this.scrollToBottom({ force: true });
  }

  /** Render an auto-compaction summary as a collapsed, non-editable transcript block. */
  private renderSummaryMessage(text: string): void {
    const inner = text.match(/<conversation-summary>\n?([\s\S]*?)\n?<\/conversation-summary>/);
    const summary = (inner ? inner[1] : text).trim();
    const el = this.messagesEl.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info"] });
    const details = el.createEl("details", { cls: "agentic-chat-info-details" });
    details.createEl("summary", { text: "Summarized earlier conversation" });
    details.createDiv({ cls: "agentic-chat-info-body", text: summary });
    this.scrollToBottom();
  }

  /** Render a collapsible block whose rows are clickable buttons (e.g. the skill picker). */
  private renderActionList(title: string, subtitle: string, items: ActionRow[]): void {
    const el = this.messagesEl.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info"] });
    const details = el.createEl("details", { cls: "agentic-chat-info-details" });
    details.open = true;
    details.createEl("summary", { text: title });
    const body = details.createDiv({ cls: "agentic-chat-info-body" });
    if (subtitle) body.createDiv({ cls: "agentic-chat-info-subtitle", text: subtitle });
    const list = body.createDiv({ cls: "agentic-chat-action-list" });
    for (const item of items) {
      const row = list.createEl("button", { cls: "agentic-chat-action-row" });
      const icon = row.createSpan({ cls: "agentic-chat-action-row-icon" });
      setIcon(icon, item.icon);
      const main = row.createDiv({ cls: "agentic-chat-action-row-main" });
      main.createSpan({ cls: "agentic-chat-action-row-label", text: item.label });
      if (item.detail) main.createSpan({ cls: "agentic-chat-action-row-detail", text: item.detail });
      row.addEventListener("click", item.onClick);
    }
    this.scrollToBottom();
  }

  private showServiceError(): void {
    const error = this.service.getError();
    if (error && !this.service.isStreaming()) this.renderErrorMessage(error);
  }

  /** Render an error block in the transcript (not sent to the model). */
  private renderErrorMessage(message: string): void {
    this.clearEmptyState();
    const el = this.messagesEl.createDiv({ cls: ["agentic-chat-message", "agentic-chat-info", "agentic-chat-info-error"] });
    const details = el.createEl("details", { cls: "agentic-chat-info-details" });
    details.open = true;
    details.createEl("summary", { text: "Error" });
    details.createDiv({ cls: "agentic-chat-info-body", text: message });
    this.scrollToBottom();
  }

  // --- session + model actions ---

  private async newSession(): Promise<void> {
    this.muteNotifications = true;
    try {
      await this.service.newSession();
      this.resetUsageNotifications();
    } finally {
      // Reset the view to a clean empty state regardless of outcome: if the
      // swap throws, leaving stale attachments/transcript behind is worse than
      // an empty pane (the service surfaces its own error separately).
      this.muteNotifications = false;
      this.attachments = [];
      // A new conversation re-attaches the active note by default (clear suppression).
      this.activeNoteSuppressed = false;
      this.lastSentPrompt = null;
      this.lastSentDisplay = null;
      this.resetHistoryNav();
      this.endEditing(false);
      this.syncActiveNote();
      this.bubble = null;
      this.renderTranscript([]);
      // A new conversation starts in the default (normal) output style.
      if (this.plugin.settings.outputStyle !== DEFAULT_OUTPUT_STYLE) {
        this.plugin.settings.outputStyle = DEFAULT_OUTPUT_STYLE;
        await this.plugin.saveSettings();
      }
      // The session reset back to unnamed — refresh the tab pill's label.
      this.syncTabStrip();
    }
  }

  /**
   * Clear one-shot notification state. When `muteExisting` is set (loading a
   * session that may already be past a threshold), pre-mark crossed thresholds so
   * the user is only toasted about *new* crossings, not the loaded-in state.
   */
  private resetUsageNotifications(muteExisting = false): void {
    this.notifiedContext = new Set<number>();
    this.notifiedCost = false;
    this.lastCompactionCount = this.service.getCompactionCount();
    if (!muteExisting) return;
    const fraction = this.service.getContextFraction();
    if (fraction !== undefined) {
      for (const threshold of CONTEXT_THRESHOLDS) {
        if (fraction >= threshold) this.notifiedContext.add(threshold);
      }
    }
    const cap = this.plugin.settings.notifications.costAlertUsd;
    if (cap > 0 && (this.service.getSessionUsage().cost?.total ?? 0) >= cap) {
      this.notifiedCost = true;
    }
  }

  private async openSessionList(): Promise<void> {
    // Hide empty sessions — a conversation with no messages isn't worth listing.
    const sessions = (await this.service.listSessions()).filter((session) => session.messageCount > 0);
    new SessionListModal(this.app, sessions, this.service.getSessionInfo()?.path ?? null, {
      load: (session) => void this.loadSession(session.path),
      delete: (session) => this.service.deleteSession(session.path),
      rename: (session, name) => this.service.renameSession(session.path, name),
    }).open();
  }

  private async loadSession(path: string): Promise<void> {
    // A session must not be open in two tabs at once (both would write the same
    // file). If another tab already has it, just switch there.
    const openIn = this.tabs.findIndex(
      (tab, index) => index !== this.activeTabIndex && tab.service.getSessionInfo()?.path === path,
    );
    if (openIn >= 0) {
      await this.switchToTab(openIn);
      return;
    }
    this.muteNotifications = true;
    try {
      await this.service.loadSession(path);
      this.resetUsageNotifications(true);
    } finally {
      this.muteNotifications = false;
    }
    this.lastSentPrompt = null;
    this.lastSentDisplay = null;
    this.endEditing(false);
    this.bubble = null;
    this.renderTranscript(this.service.getMessages());
    this.syncTabStrip();
  }

  private async switchModel(): Promise<void> {
    const { settings } = this.plugin;
    if (settings.provider !== "openrouter") {
      this.renderErrorMessage(`Set the ${modelProviderLabel(settings.provider)} model in plugin settings.`);
      return;
    }
    if (!settings.openrouterApiKey) {
      this.renderErrorMessage("Set your OpenRouter API key in settings first.");
      return;
    }
    try {
      const models = (
        await listOpenRouterModels(settings.openrouterApiKey, {
          zdr: settings.privacy.requireZDR,
          denyDataCollection: settings.privacy.denyDataCollection,
        })
      )
        .filter((model) => model.supportsTools)
        .sort((a, b) => a.id.localeCompare(b.id));
      new ModelSuggestModal(this.app, models, (model, once) => {
        if (once) {
          // Per-request override: use this model for the next prompt only, then revert.
          this.service.setModelOverride(model.id);
        } else {
          settings.openrouterModel = model.id;
          this.service.setModelOverride(null);
          void this.plugin.saveSettings();
        }
        this.syncChrome();
      }).open();
    } catch (error) {
      this.renderErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  // --- attachments ---

  private addAttachment(entry: ContextAttachment): void {
    // Image attachments only make sense for a vision-capable model.
    if (typeof entry === "string" && isImagePath(entry) && !this.service.supportsImages()) {
      new Notice("This model can't read images. Switch to a vision model to attach images.");
      return;
    }
    this.pushAttachment(entry);
  }

  /** Dedup-aware push; returns true when the attachment was newly added. The
   * multi-file drop path checks vision support itself (to aggregate the notice)
   * and routes through here, skipping the per-entry guard in addAttachment. */
  private pushAttachment(entry: ContextAttachment): boolean {
    const key = contextAttachmentKey(entry);
    if (this.attachments.some((existing) => contextAttachmentKey(existing) === key)) return false;
    this.attachments.push(entry);
    this.renderChips();
    return true;
  }

  /**
   * Recompute the auto-attached active note from the focused leaf, honoring suppression.
   * Limited to Markdown notes — the active leaf can be an image/PDF/canvas, which would
   * be read as garbage UTF-8 and injected into the prompt.
   */
  private syncActiveNote(): void {
    this.activeNotePath = autoActiveNotePath(this.app.workspace.getActiveFile(), {
      suppressed: this.activeNoteSuppressed,
      isIgnored: (path) => this.service.isPathIgnored(path),
    });
    this.renderChips();
  }

  /** The active note auto-attached this turn, or null (suppressed / none / already explicit). */
  private effectiveActiveNote(): string | null {
    return effectiveActiveNote(this.activeNoteState());
  }

  private activeNoteState(): ActiveNoteState {
    return {
      activePath: this.activeNotePath,
      suppressed: this.activeNoteSuppressed,
      explicit: this.attachments
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => attachmentBasePath(entry)),
    };
  }

  private renderChips(): void {
    this.chipsEl.empty();
    // Granted working dirs lead the context row: a persistent permission grant
    // (auto-run inside, ask outside), distinct from per-message attachments. (C1)
    for (const dir of this.plugin.settings.approval.workingDirs) {
      this.renderScopeChip(dir);
    }
    // The active note rides as a distinct, removable chip ahead of explicit attachments.
    const autoPath = this.effectiveActiveNote();
    if (autoPath) {
      this.renderChip(autoPath, true, () => {
        // Dismissing the auto chip suppresses it for the rest of the session.
        this.activeNoteSuppressed = true;
        this.activeNotePath = null;
        this.renderChips();
      });
    }
    for (const entry of this.attachments) {
      this.renderChip(entry, false, () => {
        const key = contextAttachmentKey(entry);
        this.attachments = this.attachments.filter((a) => contextAttachmentKey(a) !== key);
        this.renderChips();
      });
    }
  }

  private renderChip(entry: ContextAttachment, active: boolean, onRemove: () => void): void {
    const isText = isTextContextAttachment(entry);
    const path = typeof entry === "string" ? entry : "";
    const isFolder = path.startsWith(FOLDER_PREFIX);
    const isImage = path ? isImagePath(path) : false;
    const chip = this.chipsEl.createDiv({ cls: active ? ["agentic-chat-chip", "is-active-note"] : ["agentic-chat-chip"] });
    const icon = chip.createSpan({ cls: "agentic-chat-chip-icon" });
    setIcon(icon, isText ? "text-select" : isFolder ? "folder" : isImage ? "image" : "file-text");
    chip.createSpan({ text: isFolder ? path.slice(FOLDER_PREFIX.length) : contextAttachmentLabel(entry) });
    if (active) {
      chip.createSpan({ cls: "agentic-chat-chip-tag", text: "active" });
      chip.setAttr("title", "The active note is attached automatically — remove to stop for this session.");
    }
    const remove = chip.createSpan({ cls: "agentic-chat-chip-remove" });
    setIcon(remove, "x");
    remove.addEventListener("click", onRemove);
  }

  /** A granted working directory: persistent permission grant, removable to revoke. */
  private renderScopeChip(dir: string): void {
    const label = dir === "" ? "/ (vault root)" : dir;
    const chip = this.chipsEl.createDiv({ cls: ["agentic-chat-chip", "is-scope"] });
    const icon = chip.createSpan({ cls: "agentic-chat-chip-icon" });
    setIcon(icon, "folder-check");
    chip.createSpan({ text: label });
    chip.createSpan({ cls: "agentic-chat-chip-tag", text: "scope" });
    chip.setAttr(
      "title",
      "Working directory — the agent auto-runs inside it and asks before touching anything outside. Remove to revoke.",
    );
    const remove = chip.createSpan({ cls: "agentic-chat-chip-remove" });
    setIcon(remove, "x");
    remove.addEventListener("click", () => void this.removeWorkingDir(dir));
  }

  // --- working directories (C1: + Folder / /add-dir scope) ---

  /** Composer folder button: grant a working dir or attach a one-off folder listing. */
  private showFolderMenu(): void {
    this.clearEmptyState();
    this.renderActionList(
      "Folders",
      "Grant a working directory (auto-run inside, ask outside) or attach a folder listing as one-off context.",
      [
        {
          label: "Add working directory…",
          detail: "Auto-run reads/writes inside it; ask before anything outside.",
          icon: "folder-check",
          onClick: () => this.pickWorkingDir(),
        },
        {
          label: "Attach folder listing…",
          detail: "Add a folder's file list to your next message as context.",
          icon: "folder",
          onClick: () => this.pickFolderAttachment(),
        },
      ],
    );
  }

  /** `/dirs`: clickable list of granted working dirs (click an entry to revoke). */
  private showWorkingDirs(): void {
    this.clearEmptyState();
    const dirs = this.plugin.settings.approval.workingDirs;
    const items: ActionRow[] = [
      {
        label: "Add working directory…",
        detail: "Grant a folder as a working set.",
        icon: "folder-plus",
        onClick: () => this.pickWorkingDir(),
      },
      ...dirs.map((dir) => ({
        label: dir === "" ? "/ (vault root)" : dir,
        detail: "Granted — click to revoke.",
        icon: "folder-check",
        onClick: () => void this.removeWorkingDir(dir),
      })),
    ];
    this.renderActionList(
      "Working directories",
      dirs.length
        ? "Auto-run inside these; ask before touching anything outside."
        : "None granted — reads/writes follow your approval policy everywhere in the vault.",
      items,
    );
  }

  private pickWorkingDir(): void {
    new FolderSuggestModal(this.app, (folder) => void this.addWorkingDir(folder.path)).open();
  }

  private pickFolderAttachment(): void {
    new FolderSuggestModal(this.app, (folder) => this.addAttachment(`${FOLDER_PREFIX}${folder.path}`)).open();
  }

  /** `/add-dir [path]`: no arg opens a folder picker; an arg grants that folder directly. */
  private async runAddDir(arg: string): Promise<void> {
    this.clearEmptyState();
    if (!arg) {
      this.pickWorkingDir();
      return;
    }
    await this.addWorkingDir(arg);
  }

  private async addWorkingDir(path: string): Promise<void> {
    let normalized: string;
    try {
      // The folder picker yields "/" for the vault root, which normalizeFolderPath
      // rejects as absolute — map it to "" (the whole-vault scope) first.
      normalized = normalizeFolderPath(path === "/" ? "" : path);
    } catch {
      this.renderErrorMessage(`Invalid folder path "${path}".`);
      return;
    }
    // A working directory must be a real folder — reject typos and file paths so a
    // bogus scope can't silently weaken the boundary. "" is the vault root.
    if (normalized !== "" && !(this.app.vault.getAbstractFileByPath(normalized) instanceof TFolder)) {
      this.renderErrorMessage(`"${normalized}" is not a folder in this vault.`);
      return;
    }
    const dirs = this.plugin.settings.approval.workingDirs;
    if (dirs.includes(normalized)) {
      this.renderInfoMessage("Working directory", [[normalized || "/ (vault root)", "Already a working directory."]]);
      return;
    }
    dirs.push(normalized);
    await this.plugin.saveSettings();
    this.renderChips();
    this.syncChrome();
    this.renderInfoMessage("Working directory", [
      [
        normalized || "/ (vault root)",
        "Granted — the agent auto-runs inside it and asks before touching anything outside.",
      ],
    ]);
  }

  private async removeWorkingDir(dir: string): Promise<void> {
    const dirs = this.plugin.settings.approval.workingDirs;
    const index = dirs.indexOf(dir);
    if (index === -1) return;
    dirs.splice(index, 1);
    await this.plugin.saveSettings();
    this.renderChips();
    this.syncChrome();
  }

  private async buildContext(): Promise<string> {
    return await buildPromptContext({
      app: this.app,
      attachments: this.attachments,
      activeNotePath: this.effectiveActiveNote(),
      isPathIgnored: (path) => this.service.isPathIgnored(path),
    });
  }

  // --- rendering: static transcript ---

  private renderTranscript(messages: AgentMessage[]): void {
    this.messagesEl.empty();
    this.bubble = null;
    const toolResults = collectToolResults(messages);
    const lastAssistant = lastIndex(messages, (message) => message.role === "assistant");
    let rendered = 0;
    messages.forEach((message, index) => {
      if (message.role === "user" && isSummaryMessage(message)) {
        // A compaction summary isn't a user turn: show it as a distinct,
        // non-editable block instead of an editable user bubble.
        this.renderSummaryMessage(messageText(message));
        rendered += 1;
      } else if (message.role === "user") {
        // Hide the attachment <context> preamble so history reads like the
        // live transcript (which renders the user's text, not the prompt).
        this.renderUserMessage(stripContextPreamble(messageText(message)), [], index);
        rendered += 1;
      } else if (message.role === "assistant") {
        this.renderAssistantMessage(message, toolResults, index === lastAssistant);
        rendered += 1;
      }
    });
    if (rendered === 0) this.renderEmptyState();
    this.scrollToBottom();
  }

  private renderAssistantMessage(
    message: AgentMessage,
    toolResults: Map<string, ToolResultLite>,
    isLast: boolean,
  ): void {
    const bubble = this.newBubble();
    const reasoning = thinkingText(message);
    if (reasoning) bubble.appendReasoning(reasoning);
    for (const call of toolCalls(message)) {
      bubble.startStep(call.id, call.name, JSON.stringify(call.arguments ?? {}));
      const result = toolResults.get(call.id);
      if (result) bubble.endStep(call.id, result.text, result.isError);
    }
    const text = messageText(message);
    if (text) {
      void bubble.finalizeText(text, this.app, this);
      bubble.showActions({ canRetry: isLast });
    }
    const usage = assistantUsage(message);
    if (usage) bubble.showUsage(usage);
  }

  private renderUserMessage(text: string, attachments: ContextAttachment[], editIndex?: number): void {
    const el = this.messagesEl.createDiv({ cls: ["agentic-chat-message", "agentic-chat-user"] });
    if (attachments.length > 0) {
      const labels = attachments.map((entry) =>
        typeof entry === "string" && entry.startsWith(FOLDER_PREFIX)
          ? `${entry.slice(FOLDER_PREFIX.length)}/`
          : contextAttachmentLabel(entry),
      );
      el.createDiv({ cls: "agentic-chat-user-attachments", text: `Attached: ${labels.join(", ")}` });
    }
    el.createDiv({ cls: "agentic-chat-user-text", text });
    // Persisted turns are editable: click to reload the prompt and rewrite it.
    if (editIndex !== undefined) {
      el.addClass("is-editable");
      el.setAttribute("aria-label", "Click to edit and resend");
      el.addEventListener("click", () => {
        // Don't hijack a text selection inside this bubble (it's selectable for
        // copying); a selection elsewhere on the page shouldn't block editing.
        const selection = window.getSelection();
        if (selection?.toString() && selection.anchorNode && el.contains(selection.anchorNode)) return;
        this.beginEdit(editIndex, stripContextPreamble(text), el);
      });
    }
    this.scrollToBottom();
  }

  // --- rendering: live events ---

  private handleAgentEvent(event: AgentEvent): void {
    switch (event.type) {
      case "agent_start":
        this.clearEmptyState();
        this.bubble = null;
        this.setRunning(true);
        this.statusEl.setText("Thinking…");
        break;
      case "message_start":
        if (event.message.role === "assistant") {
          this.bubble = this.newBubble();
          this.statusEl.setText("Responding…");
        }
        break;
      case "message_update":
        this.applyStreamDelta(event.assistantMessageEvent);
        break;
      case "message_end":
        if (event.message.role === "assistant") this.finalizeBubble(event.message);
        break;
      case "tool_execution_start":
        this.statusEl.setText(`Running ${event.toolName}…`);
        this.ensureBubble().startStep(event.toolCallId, event.toolName, safeJson(event.args));
        break;
      case "tool_execution_update":
        this.ensureBubble().updateStep(event.toolCallId, event.partialResult);
        break;
      case "tool_execution_end":
        this.ensureBubble().endStep(event.toolCallId, toolResultText(event.result), event.isError);
        break;
      case "agent_end":
        this.setRunning(false);
        this.statusEl.setText("");
        this.syncChrome();
        this.notifyTurnComplete();
        break;
      default:
        break;
    }
    this.scrollToBottom();
  }

  private applyStreamDelta(event: { type: string; delta?: string }): void {
    const bubble = this.bubble;
    if (!bubble) return;
    if (event.type === "text_delta" && event.delta) bubble.appendText(event.delta);
    else if (event.type === "thinking_delta" && event.delta) bubble.appendReasoning(event.delta);
  }

  private finalizeBubble(message: AgentMessage): void {
    const bubble = this.bubble;
    if (!bubble) return;
    const text = messageText(message);
    if (text) {
      void bubble.finalizeText(text, this.app, this);
      bubble.showActions({ canRetry: true });
    }
    const errorMessage = (message as { errorMessage?: string }).errorMessage;
    if (errorMessage) bubble.showError(errorMessage);
    const usage = assistantUsage(message);
    if (usage) bubble.showUsage(usage);
  }

  private newBubble(): AssistantBubble {
    return new AssistantBubble(this.messagesEl, {
      onRetry: () => void this.retryLast(),
      onContentChange: () => this.scrollToBottom(),
    });
  }

  private ensureBubble(): AssistantBubble {
    if (!this.bubble) this.bubble = this.newBubble();
    return this.bubble;
  }

  private scrollPending = false;
  private scrollForcePending = false;

  private markUserScrollIntent(): void {
    this.userScrollIntent = true;
    if (this.userScrollIntentTimer !== null) window.clearTimeout(this.userScrollIntentTimer);
    this.userScrollIntentTimer = window.setTimeout(() => {
      this.userScrollIntent = false;
      this.userScrollIntentTimer = null;
    }, 250);
  }

  private updateScrollPinning(): void {
    if (isPinnedToBottom(this.messagesEl)) {
      this.autoScrollPinned = true;
      return;
    }
    if (this.userScrollIntent) this.autoScrollPinned = false;
  }

  private scrollToBottom(options: { force?: boolean } = {}): void {
    if (!options.force && !this.autoScrollPinned) return;
    this.scrollForcePending ||= !!options.force;
    if (this.scrollPending) return;
    this.scrollPending = true;
    window.requestAnimationFrame(() => {
      const force = this.scrollForcePending;
      this.scrollPending = false;
      this.scrollForcePending = false;
      if (!force && !this.autoScrollPinned) return;
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
      this.autoScrollPinned = isPinnedToBottom(this.messagesEl);
    });
  }
}

/** Index of the last element matching `predicate`, or -1. */
function lastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i])) return i;
  }
  return -1;
}

function modelProviderLabel(provider: string): string {
  if (provider === "ollama") return "Ollama";
  if (provider === "openai-compatible") return "OpenAI-compatible";
  return "OpenRouter";
}
