import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { Notice } from "obsidian";
import type { AgentService } from "../agent/agent-service";
import type { ToolApprovalRequest, UserApprovalChoice } from "../agent/tool-call-controller";
import type { AskUserRequest } from "../tools/ask-user-tool";
import type { ApprovalCard } from "./approval-card";
import { freshChatTabState, type ChatTabWorkingState } from "./chat-tab-state";
import { TabStrip, type TabHeaderElements, type TabView } from "./tab-strip";
import { tabStatus } from "./tab-status";
import { errorMessage } from "../utils/errors";
import { restoreUndeliveredText, UNDELIVERED_STEER_STATUS } from "./composer-input";

/** One open conversation in the leaf: its own agent service + saved UI state. */
export interface ChatTab {
  service: AgentService;
  unsubscribe: () => void;
  state: ChatTabWorkingState;
  /** A background turn finished and the user has not looked at it yet. */
  unread?: boolean;
  /**
   * Approval cards waiting in this tab's transcript. Parallel tool calls (MCP
   * tools run in parallel) can ask at once, so this is a list, not one slot.
   */
  pendingApprovals?: ApprovalCard[];
}

/** Maximum independent sessions ("tabs") in one chat leaf. Each tab owns an AgentService. */
export const MAX_TABS = 5;

export interface ChatTabsDeps {
  createService: (handlers: {
    askUser: (request: AskUserRequest, signal?: AbortSignal) => Promise<string>;
    confirmToolCall: (request: ToolApprovalRequest, signal?: AbortSignal) => Promise<UserApprovalChoice>;
  }) => AgentService;
  askUser: (tab: ChatTab, request: AskUserRequest, signal?: AbortSignal) => Promise<string>;
  confirmToolCall: (tab: ChatTab, request: ToolApprovalRequest, signal?: AbortSignal) => Promise<UserApprovalChoice>;
  onActiveEvent: (event: AgentEvent) => void;
  onBackgroundFinished: (tabNumber: number) => void;
  isViewClosed: () => boolean;
  header: () => TabHeaderElements | undefined;
  openHistory: () => void;
  composerValue: () => string;
  setComposerValueQuiet: (value: string) => void;
  setStatus: (text: string) => void;
  prepareSwitch: () => void;
  endEditing: () => void;
  renderChips: () => void;
  syncChrome: () => void;
  flushQueuedPromptIfReady: () => void | Promise<void>;
  renderActiveTab: () => void;
  initializeFreshTab: (tab: ChatTab) => Promise<void>;
  startNewConversation: () => Promise<void>;
}

/**
 * Owns the tab array, the active index, and the tab strip. Each tab carries an
 * independent agent service and working state; switching tabs only moves the
 * composer draft in and out of the textarea.
 */
export class ChatTabs {
  private tabs: ChatTab[] = [];
  private activeIndex = 0;
  private strip: TabStrip | null = null;
  private stripHeader: TabHeaderElements | null = null;

  constructor(private readonly deps: ChatTabsDeps) {}

  allTabs(): ChatTab[] {
    return this.tabs;
  }

  get activeIndexValue(): number {
    return this.activeIndex;
  }

  setActiveIndex(index: number): void {
    this.activeIndex = index;
  }

  setTabs(tabs: ChatTab[], activeIndex = 0): void {
    this.tabs = tabs;
    this.activeIndex = activeIndex;
  }

  get activeTab(): ChatTab {
    return this.tabs[this.activeIndex];
  }

  get service(): AgentService {
    return this.activeTab.service;
  }

  indexOf(tab: ChatTab): number {
    return this.tabs.indexOf(tab);
  }

  findIndex(predicate: (tab: ChatTab, index: number) => boolean): number {
    return this.tabs.findIndex((tab, index) => predicate(tab, index));
  }

  /** Build a tab with its own agent service and a tab-aware event subscription. */
  createTab(): ChatTab {
    const tabRef: { current?: ChatTab } = {};
    const service = this.deps.createService({
      askUser: (request, signal) => {
        if (!tabRef.current) throw new Error("The chat tab is not ready to ask the user.");
        return this.deps.askUser(tabRef.current, request, signal);
      },
      confirmToolCall: (request, signal) => {
        if (!tabRef.current) throw new Error("The chat tab is not ready for approval.");
        return this.deps.confirmToolCall(tabRef.current, request, signal);
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

  /** Park the composer draft on the active tab before another tab takes the textarea. */
  parkDraft(): void {
    const tab = this.tabs[this.activeIndex];
    if (tab) tab.state.draft = this.deps.composerValue();
  }

  /** Put the active tab's parked draft back into the textarea. */
  restoreDraft(): void {
    const tab = this.tabs[this.activeIndex];
    if (!tab) return;
    tab.state.history.resetNavigation();
    this.deps.setComposerValueQuiet(tab.state.draft);
  }

  async switchToTab(index: number): Promise<void> {
    if (index === this.activeIndex || index < 0 || index >= this.tabs.length) return;
    this.deps.prepareSwitch();
    this.parkDraft();
    this.activeIndex = index;
    this.tabs[index].unread = false;
    this.restoreDraft();
    this.deps.renderActiveTab();
  }

  /** `+`: open a new tab on a fresh session and switch to it (capped at MAX_TABS). */
  async addTab(): Promise<void> {
    if (this.tabs.length >= MAX_TABS) return;
    this.deps.endEditing();
    this.parkDraft();
    const tab = this.createTab();
    this.tabs.push(tab);
    this.activeIndex = this.tabs.length - 1;
    // Show the fresh tab's empty draft before any async work renders against it.
    this.restoreDraft();
    await this.deps.initializeFreshTab(tab);
  }

  /** `×`: close a tab, disposing its session. Closing the only tab resets it instead. */
  closeTab(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    if (this.tabs.length <= 1) {
      void this.deps.startNewConversation();
      return;
    }
    const closingActive = index === this.activeIndex;
    if (closingActive) this.deps.endEditing();
    const [tab] = this.tabs.splice(index, 1);
    tab.unsubscribe();
    for (const card of tab.pendingApprovals ?? []) card.stop();
    tab.service.dispose();
    if (index < this.activeIndex) {
      this.activeIndex -= 1;
    } else if (closingActive) {
      this.activeIndex = Math.min(this.activeIndex, this.tabs.length - 1);
      // The closed tab was showing; restore + render whichever tab took its place.
      this.restoreDraft();
      this.deps.renderActiveTab();
      return;
    }
    this.syncTabStrip();
  }

  /** The tab's name for notices: its label, else the session name. */
  tabLabel(tab: ChatTab): string {
    const info = tab.service.getSessionInfo();
    return info?.tabLabel?.trim() || info?.name?.trim() || "New chat";
  }

  /** Rename tab `index` (set or clear its label). The session name stays. */
  async renameTab(index: number, label: string | undefined): Promise<void> {
    const tab = this.tabs[index];
    if (!tab) return;
    try {
      await tab.service.setTabLabel(label);
    } catch (error) {
      new Notice(`Could not rename the tab: ${errorMessage(error)}`);
    }
    this.syncTabStrip();
  }

  private ensureStrip(): TabStrip | null {
    const header = this.deps.header();
    if (!header) return null;
    if (this.strip && this.stripHeader === header) return this.strip;
    this.strip?.dispose();
    this.stripHeader = header;
    this.strip = new TabStrip(header, {
      activate: (index) => void this.switchToTab(index),
      close: (index) => this.closeTab(index),
      rename: (index, label) => void this.renameTab(index, label),
      openHistory: () => this.deps.openHistory(),
    });
    return this.strip;
  }

  /** Render the header tabs: number or label, status dot, overflow. */
  syncTabStrip(): void {
    const strip = this.ensureStrip();
    if (!strip) return;
    const views: TabView[] = this.tabs.map((tab, index) => {
      const info = tab.service.getSessionInfo();
      const active = index === this.activeIndex;
      return {
        label: info?.tabLabel,
        sessionName: info?.name,
        status: tabStatus({
          needsApproval: (tab.pendingApprovals?.length ?? 0) > 0,
          streaming: tab.service.isStreaming(),
          error: !active && !!tab.service.getError(),
          unread: !active && !!tab.unread,
        }),
      };
    });
    strip.render(views, this.activeIndex, this.tabs.length < MAX_TABS, MAX_TABS);
  }

  private handleTabEvent(tab: ChatTab, event: AgentEvent): void {
    if (tab === this.activeTab) {
      this.deps.onActiveEvent(event);
      return;
    }
    // A background tab finishing while you're viewing another: surface it.
    if (event.type === "agent_end") {
      tab.unread = true;
      this.deps.onBackgroundFinished(this.tabs.indexOf(tab) + 1);
    }
    this.syncTabStrip();
  }

  private handleTabChange(tab: ChatTab): void {
    this.syncTabStrip();
    if (tab === this.activeTab) this.deps.syncChrome();
    // After syncChrome, so the restored-draft status line is not cleared.
    this.restoreUndeliveredSteers(tab);
    if (tab === this.activeTab) void this.deps.flushQueuedPromptIfReady();
  }

  isLiveTab(tab: ChatTab): boolean {
    return !this.deps.isViewClosed() && this.tabs[this.activeIndex] === tab;
  }

  /** Whether any tab in this leaf is streaming — covers background tabs for the settings gate. */
  isAnyTabStreaming(): boolean {
    for (const tab of this.tabs) {
      if (tab.service.isStreaming()) return true;
    }
    return false;
  }

  /** Steered text the run never delivered goes back into that tab's composer draft. */
  private restoreUndeliveredSteers(tab: ChatTab): void {
    const texts = tab.service.takeUndeliveredSteers();
    if (texts.length === 0) return;
    const isActive = tab === this.activeTab;
    const value = restoreUndeliveredText(isActive ? this.deps.composerValue() : tab.state.draft, texts);
    if (value === null) return;
    if (!isActive) {
      tab.state.draft = value;
      return;
    }
    this.deps.setComposerValueQuiet(value);
    this.deps.setStatus(UNDELIVERED_STEER_STATUS);
  }

  /** Clear the tab array after the view closes. */
  clear(): void {
    this.tabs = [];
    this.activeIndex = 0;
    this.strip?.dispose();
    this.strip = null;
    this.stripHeader = null;
  }
}
