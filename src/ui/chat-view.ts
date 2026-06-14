import {
  ItemView,
  Notice,
  TFile,
  TFolder,
  type WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type AgenticChatPlugin from "../main";
import { VIEW_TYPE_AGENT_CHAT } from "../constants";
import { activeModelId } from "../settings";
import { listOpenRouterModels } from "../llm/models";
import { ModelSuggestModal } from "./model-suggest-modal";
import { SessionListModal } from "./session-list-modal";
import { FolderSuggestModal } from "./folder-suggest";
import { highestUnnotifiedThreshold, Notifier } from "./notifications";
import { AssistantBubble } from "./assistant-bubble";
import { formatCost, formatUsage, safeJson } from "./format";
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
import { resolveCommand, visibleCommands } from "./commands";
import { type AgentMode, MODE_ORDER, MODES } from "../agent/modes";
import { type OutputStyle, OUTPUT_STYLE_ORDER, OUTPUT_STYLES } from "../agent/output-styles";

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

export class ChatView extends ItemView {
  private attachments: string[] = [];
  private bubble: AssistantBubble | null = null;
  private unsubscribers: Array<() => void> = [];
  private readonly notifier = new Notifier(() => this.plugin.settings.notifications.enabled);
  private notifiedContext = new Set<number>();
  private notifiedCost = false;
  // The service fires onChange synchronously during session transitions; this silences
  // automatic toasts until the new session's notification baseline has been set.
  private muteNotifications = false;

  // Autocomplete state: the active query token and a cached mention candidate list.
  private activeQuery: AcQuery | null = null;
  private mentionCache: MentionCandidate[] | null = null;
  // Last turn we sent, kept so "retry" re-runs it without re-showing the context preamble.
  private lastSentPrompt: string | null = null;
  private lastSentDisplay: string | null = null;
  // When editing a sent prompt, the index of the user message being rewritten.
  private editingIndex: number | null = null;
  private editingEl: HTMLElement | null = null;
  // The composer draft to restore if the user cancels an edit.
  private draftBeforeEdit: string | null = null;

  private messagesEl!: HTMLElement;
  private emptyStateEl: HTMLElement | null = null;
  private chipsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private modeSelectEl!: HTMLSelectElement;
  private styleSelectEl!: HTMLSelectElement;
  private menu!: AutocompleteMenu;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private modelPillEl!: HTMLElement;
  private usageEl!: HTMLElement;

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

  private get service() {
    return this.plugin.agentService;
  }

  async onOpen(): Promise<void> {
    this.buildLayout();
    this.unsubscribers.push(this.service.onEvent((event) => this.handleAgentEvent(event)));
    this.unsubscribers.push(this.service.onChange(() => this.syncChrome()));
    // The mention list is cached; drop it whenever the vault's file set changes.
    const invalidate = () => {
      this.mentionCache = null;
    };
    this.registerEvent(this.app.vault.on("create", invalidate));
    this.registerEvent(this.app.vault.on("delete", invalidate));
    this.registerEvent(this.app.vault.on("rename", invalidate));
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
    this.renderTranscript(this.service.getMessages());
    this.syncChrome();
  }

  async onClose(): Promise<void> {
    this.cancelAutocomplete();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
  }

  private buildLayout(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("agentic-chat-view");

    const header = root.createDiv({ cls: "agentic-chat-header" });
    header.createDiv({ cls: "agentic-chat-title", text: "Agentic chat" });
    this.modelPillEl = header.createDiv({ cls: "agentic-chat-model-pill", attr: { "aria-label": "Switch model" } });
    this.modelPillEl.addEventListener("click", () => void this.switchModel());

    const actions = header.createDiv({ cls: "agentic-chat-header-actions" });
    const historyButton = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "Conversation history" },
    });
    setIcon(historyButton, "history");
    historyButton.addEventListener("click", () => void this.openSessionList());
    const newChatButton = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "New chat" },
    });
    setIcon(newChatButton, "plus");
    newChatButton.addEventListener("click", () => void this.newSession());

    this.messagesEl = root.createDiv({ cls: "agentic-chat-messages" });
    this.renderEmptyState();

    const composer = root.createDiv({ cls: "agentic-chat-composer" });
    this.chipsEl = composer.createDiv({ cls: "agentic-chat-chips" });

    const inputWrap = composer.createDiv({ cls: "agentic-chat-input-wrap" });
    this.inputEl = inputWrap.createEl("textarea", {
      cls: "agentic-chat-input",
      attr: { rows: "3", placeholder: "Ask about your vault — / for commands, @ to attach a note… (Enter to send)" },
    });
    this.menu = new AutocompleteMenu(inputWrap, (item) => this.chooseAutocomplete(item));
    this.inputEl.addEventListener("keydown", (event) => {
      if (this.menu.handleKey(event)) return;
      if (event.key === "Escape" && this.editingIndex !== null) {
        event.preventDefault();
        this.cancelEditing();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.submit();
      }
    });
    this.inputEl.addEventListener("input", () => this.scheduleAutocomplete());
    this.inputEl.addEventListener("click", () => this.scheduleAutocomplete());
    this.inputEl.addEventListener("keyup", (event) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) this.scheduleAutocomplete();
    });
    this.inputEl.addEventListener("blur", () => {
      this.cancelAutocomplete();
      this.menu.hide();
    });

    const controls = composer.createDiv({ cls: "agentic-chat-controls" });
    this.modeSelectEl = this.buildControlSelect(
      controls,
      "Agent mode",
      MODE_ORDER.map((id) => ({ value: id, label: MODES[id].label, title: MODES[id].description })),
      this.plugin.settings.mode,
      (value) => this.setMode(value as AgentMode),
    );
    this.styleSelectEl = this.buildControlSelect(
      controls,
      "Output style",
      OUTPUT_STYLE_ORDER.map((id) => ({ value: id, label: OUTPUT_STYLES[id].label, title: OUTPUT_STYLES[id].description })),
      this.plugin.settings.outputStyle,
      (value) => this.setOutputStyle(value as OutputStyle),
    );

    const buttonRow = composer.createDiv({ cls: "agentic-chat-buttons" });
    const attachNoteButton = buttonRow.createEl("button", {
      cls: "agentic-chat-attach",
      text: "+ Active note",
      attr: { "aria-label": "Attach the active note as context" },
    });
    attachNoteButton.addEventListener("click", () => this.attachActiveNote());
    const attachFolderButton = buttonRow.createEl("button", {
      cls: "agentic-chat-attach",
      text: "+ Folder",
      attr: { "aria-label": "Attach a folder listing as context" },
    });
    attachFolderButton.addEventListener("click", () => {
      new FolderSuggestModal(this.app, (folder) => this.addAttachment(`${FOLDER_PREFIX}${folder.path}`)).open();
    });

    this.statusEl = buttonRow.createDiv({ cls: "agentic-chat-status" });
    this.stopButton = buttonRow.createEl("button", { cls: ["agentic-chat-stop", "mod-warning"], text: "Stop" });
    this.stopButton.hide();
    this.stopButton.addEventListener("click", () => this.service.abort());
    this.sendButton = buttonRow.createEl("button", { cls: "mod-cta", text: "Send" });
    this.sendButton.addEventListener("click", () => void this.submit());

    this.usageEl = composer.createDiv({ cls: "agentic-chat-usage" });

    // Dragging a note onto the composer should attach it as context, not open it.
    this.registerDomEvent(composer, "dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    this.registerDomEvent(composer, "drop", (event) => this.handleDrop(event));
  }

  /** Turn a dropped note/folder into a context attachment instead of opening it. */
  private handleDrop(event: DragEvent): void {
    const data =
      event.dataTransfer?.getData("text/plain") || event.dataTransfer?.getData("text/uri-list") || "";
    const path = parseDroppedVaultPath(data, this.app.vault.getName());
    if (!path) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    // Only intercept real vault entries; otherwise let Obsidian handle the drop.
    if (!(file instanceof TFile) && !(file instanceof TFolder)) return;
    event.preventDefault();
    event.stopPropagation();
    this.addAttachment(file instanceof TFolder ? `${FOLDER_PREFIX}${path}` : path);
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

  // --- composer controls (mode + output style) ---

  /** A compact labelled `<select>` for the composer control row. */
  private buildControlSelect(
    parent: HTMLElement,
    ariaLabel: string,
    options: Array<{ value: string; label: string; title?: string }>,
    value: string,
    onChange: (value: string) => void,
  ): HTMLSelectElement {
    const select = parent.createEl("select", {
      cls: ["dropdown", "agentic-chat-control-select"],
      attr: { "aria-label": ariaLabel },
    });
    for (const option of options) {
      const el = select.createEl("option", { text: option.label, value: option.value });
      if (option.title) el.title = option.title;
    }
    select.value = value;
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  private async setMode(mode: AgentMode): Promise<void> {
    // Mode is evaluated live by the tool gate; changing it mid-stream would
    // disagree with the system prompt this run started under. Lock it while busy.
    if (this.service.isStreaming()) return;
    if (this.plugin.settings.mode === mode) return;
    this.plugin.settings.mode = mode;
    await this.plugin.saveSettings();
    this.syncControls();
  }

  private async setOutputStyle(style: OutputStyle): Promise<void> {
    if (this.service.isStreaming()) return;
    if (this.plugin.settings.outputStyle === style) return;
    this.plugin.settings.outputStyle = style;
    await this.plugin.saveSettings();
    this.syncControls();
  }

  /**
   * Reflect settings (e.g. changed via /config or the settings tab) back into the
   * selects, and disable them while the agent is streaming so mode/style can't drift
   * from the prompt/policy the in-flight turn started under.
   */
  private syncControls(): void {
    const { settings } = this.plugin;
    const streaming = this.service.isStreaming();
    if (this.modeSelectEl) {
      if (this.modeSelectEl.value !== settings.mode) this.modeSelectEl.value = settings.mode;
      this.modeSelectEl.disabled = streaming;
    }
    if (this.styleSelectEl) {
      if (this.styleSelectEl.value !== settings.outputStyle) this.styleSelectEl.value = settings.outputStyle;
      this.styleSelectEl.disabled = streaming;
    }
  }

  // --- chrome (header pill, usage, running state) ---

  private syncChrome(): void {
    const { settings } = this.plugin;
    this.syncControls();
    this.modelPillEl.empty();
    const providerLabel = settings.provider === "ollama" ? "Ollama" : "OpenRouter";
    this.modelPillEl.createSpan({ cls: "agentic-chat-model-provider", text: providerLabel });
    this.modelPillEl.createSpan({ cls: "agentic-chat-model-name", text: activeModelId(settings) });

    const usage = this.service.getSessionUsage();
    const fraction = this.service.getContextFraction();
    const parts: string[] = [];
    if (usage.totalTokens > 0) parts.push(formatUsage(usage));
    if (fraction !== undefined) parts.push(`${Math.round(fraction * 100)}% ctx`);
    this.usageEl.setText(parts.join(" · "));

    const error = this.service.getError();
    this.setRunning(this.service.isStreaming());
    if (error && !this.service.isStreaming()) this.statusEl.setText("");
    this.checkUsageNotifications();
  }

  /** Fire one-shot background toasts as the context window fills or cost crosses the cap. */
  private checkUsageNotifications(): void {
    if (this.muteNotifications) return;
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
    if (this.leaf === this.app.workspace.activeLeaf) return;
    this.notifier.notify("agentFinished", "Agentic chat finished responding.");
  }

  private setRunning(running: boolean): void {
    this.sendButton.disabled = running;
    if (running) {
      this.stopButton.show();
    } else {
      this.stopButton.hide();
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

    const editIndex = this.editingIndex;
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
    if (this.editingIndex === index) return;
    this.clearEditingHighlight();
    // Stash the composer draft on first entry so Esc can restore it.
    if (this.editingIndex === null) this.draftBeforeEdit = this.inputEl.value;
    this.editingIndex = index;
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
    const draft = this.draftBeforeEdit;
    this.draftBeforeEdit = null;
    if (this.editingIndex === null) return;
    this.editingIndex = null;
    this.clearEditingHighlight();
    if (restoreDraft && draft !== null) this.setComposerValue(draft);
    this.statusEl.setText("");
  }

  /** Set the composer text and notify input listeners (autocomplete) of the change. */
  private setComposerValue(value: string): void {
    this.inputEl.value = value;
    this.inputEl.dispatchEvent(new Event("input"));
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
    const attachments = [...this.attachments];
    const context = await this.buildContext();
    const prompt = context ? `${context}\n\n${text}` : text;
    this.lastSentPrompt = prompt;
    this.lastSentDisplay = text;
    this.renderUserMessage(text, attachments);
    await this.service.sendPrompt(prompt);
    this.showServiceError();
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
    if (!command) return false;
    switch (command.name) {
      case "new":
        await this.newSession();
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
      case "config":
        this.showConfig();
        return true;
      case "usage":
        this.showUsage();
        return true;
      case "skill":
        await this.runSkill(rest[0], argString.slice(rest[0]?.length ?? 0).trim());
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

  private async runSkill(name: string | undefined, extra: string): Promise<void> {
    if (!name) {
      this.showSkillList();
      return;
    }
    this.clearEmptyState();
    this.renderUserMessage(`/skill ${name}${extra ? ` ${extra}` : ""}`, []);
    await this.service.invokeSkill(name, extra || undefined);
    this.showServiceError();
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
    this.clearEmptyState();
    this.renderInfoMessage("Status", [
      ["Provider", settings.provider],
      ["Model", activeModelId(settings)],
      ["Mode", MODES[settings.mode].label],
      ["Output style", OUTPUT_STYLES[settings.outputStyle].label],
      ["Thinking", settings.thinkingLevel],
      ["Approval (mutating)", settings.approval.mutating],
      ["Session", session ? `${session.messageCount} messages` : "(none)"],
    ]);
  }

  /** `/config`: clickable pickers for mode and output style, applied in-pane. */
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

  private async chooseMode(mode: AgentMode): Promise<void> {
    await this.setMode(mode);
    this.renderInfoMessage("Mode", [[MODES[mode].label, MODES[mode].description]]);
  }

  private async chooseStyle(style: OutputStyle): Promise<void> {
    await this.setOutputStyle(style);
    this.renderInfoMessage("Output style", [[OUTPUT_STYLES[style].label, OUTPUT_STYLES[style].description]]);
  }

  private showUsage(): void {
    const usage = this.service.getSessionUsage();
    this.clearEmptyState();
    this.renderInfoMessage(
      "Usage",
      usage.totalTokens > 0
        ? [
            ["Tokens", String(usage.totalTokens)],
            ["Cost", formatCost(usage.cost?.total ?? 0)],
          ]
        : [["Usage", "No usage recorded yet for this conversation."]],
    );
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
      this.muteNotifications = false;
    }
    this.attachments = [];
    this.lastSentPrompt = null;
    this.lastSentDisplay = null;
    this.endEditing(false);
    this.renderChips();
    this.bubble = null;
    this.renderTranscript([]);
  }

  /**
   * Clear one-shot notification state. When `muteExisting` is set (loading a
   * session that may already be past a threshold), pre-mark crossed thresholds so
   * the user is only toasted about *new* crossings, not the loaded-in state.
   */
  private resetUsageNotifications(muteExisting = false): void {
    this.notifiedContext = new Set<number>();
    this.notifiedCost = false;
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
  }

  private async switchModel(): Promise<void> {
    const { settings } = this.plugin;
    if (settings.provider !== "openrouter") {
      this.renderErrorMessage("Set the Ollama model in plugin settings.");
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
      new ModelSuggestModal(this.app, models, async (model) => {
        settings.openrouterModel = model.id;
        await this.plugin.saveSettings();
        this.syncChrome();
      }).open();
    } catch (error) {
      this.renderErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  // --- attachments ---

  private attachActiveNote(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      this.renderErrorMessage("No active note to attach.");
      return;
    }
    this.addAttachment(file.path);
  }

  private addAttachment(entry: string): void {
    if (this.attachments.includes(entry)) return;
    this.attachments.push(entry);
    this.renderChips();
  }

  private renderChips(): void {
    this.chipsEl.empty();
    for (const entry of this.attachments) {
      const chip = this.chipsEl.createDiv({ cls: "agentic-chat-chip" });
      const icon = chip.createSpan({ cls: "agentic-chat-chip-icon" });
      setIcon(icon, entry.startsWith(FOLDER_PREFIX) ? "folder" : "file-text");
      chip.createSpan({ text: entry.startsWith(FOLDER_PREFIX) ? entry.slice(FOLDER_PREFIX.length) : entry });
      const remove = chip.createSpan({ cls: "agentic-chat-chip-remove" });
      setIcon(remove, "x");
      remove.addEventListener("click", () => {
        this.attachments = this.attachments.filter((a) => a !== entry);
        this.renderChips();
      });
    }
  }

  private async buildContext(): Promise<string> {
    if (this.attachments.length === 0) return "";
    const sections: string[] = [];
    for (const entry of this.attachments) {
      if (entry.startsWith(FOLDER_PREFIX)) {
        const folderPath = entry.slice(FOLDER_PREFIX.length);
        const folder = folderPath === "/" ? this.app.vault.getRoot() : this.app.vault.getAbstractFileByPath(folderPath);
        if (folder instanceof TFolder) {
          const listing = folder.children
            .map((child) => (child instanceof TFolder ? `${child.name}/` : child.name))
            .join("\n");
          sections.push(`Folder listing for "${folderPath}":\n${listing || "(empty)"}`);
        }
      } else {
        const file = this.app.vault.getAbstractFileByPath(entry);
        if (file instanceof TFile) {
          const content = await this.app.vault.cachedRead(file);
          sections.push(`Contents of note "${entry}":\n\n${content}`);
        }
      }
    }
    if (sections.length === 0) return "";
    return `<context>\nThe user attached the following from their vault:\n\n${sections.join("\n\n---\n\n")}\n</context>`;
  }

  // --- rendering: static transcript ---

  private renderTranscript(messages: AgentMessage[]): void {
    this.messagesEl.empty();
    this.bubble = null;
    const toolResults = collectToolResults(messages);
    const lastAssistant = lastIndex(messages, (message) => message.role === "assistant");
    let rendered = 0;
    messages.forEach((message, index) => {
      if (message.role === "user") {
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

  private renderUserMessage(text: string, attachments: string[], editIndex?: number): void {
    const el = this.messagesEl.createDiv({ cls: ["agentic-chat-message", "agentic-chat-user"] });
    if (attachments.length > 0) {
      const labels = attachments.map((entry) =>
        entry.startsWith(FOLDER_PREFIX) ? `${entry.slice(FOLDER_PREFIX.length)}/` : entry,
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
    return new AssistantBubble(this.messagesEl, { onRetry: () => void this.retryLast() });
  }

  private ensureBubble(): AssistantBubble {
    if (!this.bubble) this.bubble = this.newBubble();
    return this.bubble;
  }

  private scrollPending = false;

  private scrollToBottom(): void {
    if (this.scrollPending) return;
    this.scrollPending = true;
    requestAnimationFrame(() => {
      this.scrollPending = false;
      this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
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
