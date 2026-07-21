import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface SessionUiResetOptions {
  attachments?: boolean;
  activeNoteSuppression?: boolean;
  activeNoteCache?: boolean;
  lastSent?: boolean;
  history?: boolean;
  editing?: boolean;
  bubble?: boolean;
}

export interface SessionActivationCoordinatorOptions {
  setMuteNotifications: (muted: boolean) => void;
  resetUsageNotifications: (muteExisting?: boolean) => void;
  resetUiState: (options: SessionUiResetOptions) => void;
  messages: () => AgentMessage[];
  renderTranscript: (messages: AgentMessage[]) => void;
  syncActiveNote: () => void;
  syncTabStrip: () => void;
  syncChrome: () => void;
  flushQueuedPromptIfReady: () => void | Promise<void>;
}

const CLEAN_CONVERSATION_RESET: SessionUiResetOptions = {
  attachments: true,
  activeNoteSuppression: true,
  activeNoteCache: true,
  lastSent: true,
  history: true,
  editing: true,
  bubble: true,
};

export class SessionActivationCoordinator {
  constructor(private readonly options: SessionActivationCoordinatorOptions) {}

  renderActiveTab(): void {
    this.options.resetUiState({ editing: true, bubble: true });
    this.options.setMuteNotifications(true);
    try {
      this.options.syncActiveNote();
      this.options.renderTranscript(this.options.messages());
      this.options.syncChrome();
      void this.options.flushQueuedPromptIfReady();
    } finally {
      this.options.setMuteNotifications(false);
    }
    this.options.syncTabStrip();
  }

  async initializeFreshTab(startSession: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
    this.options.setMuteNotifications(true);
    try {
      await startSession();
      this.options.resetUsageNotifications(false);
    } catch (error) {
      onError(error);
    } finally {
      this.options.setMuteNotifications(false);
    }
    this.renderActiveTab();
  }

  async initializeActiveSession(initialize: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
    this.options.setMuteNotifications(true);
    try {
      await initialize();
      this.options.resetUsageNotifications(true);
    } catch (error) {
      onError(error);
    } finally {
      this.options.setMuteNotifications(false);
    }
    this.options.syncActiveNote();
    this.options.renderTranscript(this.options.messages());
    this.options.syncChrome();
    this.options.syncTabStrip();
  }

  async startNewConversation(startSession: () => Promise<void>): Promise<void> {
    this.options.setMuteNotifications(true);
    try {
      await startSession();
      this.options.resetUsageNotifications(false);
    } finally {
      this.options.setMuteNotifications(false);
      this.options.resetUiState(CLEAN_CONVERSATION_RESET);
      this.options.syncActiveNote();
      this.options.renderTranscript([]);
      this.options.syncChrome();
      this.options.syncTabStrip();
    }
  }

  async loadConversation(loadSession: () => Promise<void>): Promise<void> {
    await this.runMuted(loadSession, true);
    this.options.resetUiState({ lastSent: true, activeNoteCache: true, editing: true, bubble: true });
    this.options.renderTranscript(this.options.messages());
    this.options.syncChrome();
    this.options.syncTabStrip();
  }

  async continueProjectSession(continueSession: () => Promise<void>): Promise<void> {
    this.options.resetUiState({
      attachments: true,
      activeNoteSuppression: true,
      activeNoteCache: true,
      lastSent: true,
      editing: true,
    });
    await this.runMuted(continueSession, true);
    this.options.renderTranscript(this.options.messages());
    this.options.syncTabStrip();
    this.options.syncActiveNote();
    this.options.syncChrome();
  }

  afterSessionsCleared(): void {
    this.options.resetUiState(CLEAN_CONVERSATION_RESET);
    this.options.resetUsageNotifications(false);
    this.options.renderTranscript(this.options.messages());
    this.options.syncActiveNote();
    this.options.syncTabStrip();
    this.options.syncChrome();
  }

  private async runMuted(operation: () => Promise<void>, muteExisting: boolean): Promise<void> {
    this.options.setMuteNotifications(true);
    try {
      await operation();
      this.options.resetUsageNotifications(muteExisting);
    } finally {
      this.options.setMuteNotifications(false);
    }
  }
}
