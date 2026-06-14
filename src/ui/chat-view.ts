import {
  type App,
  type Component,
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  TFolder,
  type WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type AgenticChatPlugin from "../main";
import { VIEW_TYPE_AGENT_CHAT } from "../constants";
import { activeModelId } from "../settings";
import { listOpenRouterModels } from "../llm/models";
import { ModelSuggestModal } from "./model-suggest-modal";
import { SessionListModal } from "./session-list-modal";
import { FolderSuggestModal } from "./folder-suggest";
import { highestUnnotifiedThreshold, Notifier } from "./notifications";

export { VIEW_TYPE_AGENT_CHAT };

const FOLDER_PREFIX = "folder:";
/** Context-window fill fractions that trigger a background notification, once each. */
const CONTEXT_THRESHOLDS = [0.75, 0.9] as const;

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export class ChatView extends ItemView {
  private attachments: string[] = [];
  private bubble: AssistantBubble | null = null;
  private unsubscribers: Array<() => void> = [];
  private readonly notifier = new Notifier(() => this.plugin.settings.notifications.enabled);
  private notifiedContext = new Set<number>();
  private notifiedCost = false;

  private messagesEl!: HTMLElement;
  private emptyStateEl: HTMLElement | null = null;
  private chipsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
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
    try {
      await this.service.initialize();
    } catch (error) {
      new Notice(`Agentic chat: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.renderTranscript(this.service.getMessages());
    this.syncChrome();
  }

  async onClose(): Promise<void> {
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
    this.inputEl = composer.createEl("textarea", {
      cls: "agentic-chat-input",
      attr: { rows: "3", placeholder: "Ask about your vault, or type / for commands… (Enter to send)" },
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.submit();
      }
    });

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
  }

  private renderEmptyState(): void {
    this.emptyStateEl = this.messagesEl.createDiv({ cls: "agentic-chat-empty" });
    const icon = this.emptyStateEl.createDiv({ cls: "agentic-chat-empty-icon" });
    setIcon(icon, "bot");
    this.emptyStateEl.createDiv({
      cls: "agentic-chat-empty-text",
      text: "Ask anything about your vault. The agent can read, search, write, and edit notes — every tool call is shown inline. Type / for commands.",
    });
  }

  private clearEmptyState(): void {
    this.emptyStateEl?.detach();
    this.emptyStateEl = null;
  }

  // --- chrome (header pill, usage, running state) ---

  private syncChrome(): void {
    const { settings } = this.plugin;
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
    if (running) this.stopButton.show();
    else {
      this.stopButton.hide();
      if (!running) this.statusEl.setText("");
    }
  }

  // --- submission + slash commands ---

  private async submit(): Promise<void> {
    if (this.service.isStreaming()) return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      const handled = await this.handleSlashCommand(text);
      if (handled) {
        this.inputEl.value = "";
        return;
      }
    }
    this.inputEl.value = "";
    await this.sendPrompt(text);
  }

  private async sendPrompt(text: string): Promise<void> {
    this.clearEmptyState();
    const attachments = [...this.attachments];
    const context = await this.buildContext();
    const prompt = context ? `${context}\n\n${text}` : text;
    this.renderUserMessage(text, attachments);
    await this.service.sendPrompt(prompt);
    this.showServiceError();
  }

  private async handleSlashCommand(raw: string): Promise<boolean> {
    const [command, ...rest] = raw.slice(1).split(/\s+/);
    const argString = raw.slice(1 + command.length).trim();
    switch (command.toLowerCase()) {
      case "new":
        await this.newSession();
        return true;
      case "sessions":
      case "history":
        await this.openSessionList();
        return true;
      case "model":
        await this.switchModel();
        return true;
      case "status":
        this.showStatus();
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

  private showSkillList(): void {
    const skills = this.service.getSkills();
    this.clearEmptyState();
    this.renderInfoMessage(
      "Skills",
      skills.length
        ? skills.map((skill): [string, string] => [skill.name, skill.description])
        : [["(none)", "Set a skills folder in settings to add skills."]],
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
      ["Thinking", settings.thinkingLevel],
      ["Approval (mutating)", settings.approval.mutating],
      ["Session", session ? `${session.messageCount} messages` : "(none)"],
    ]);
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
    this.renderInfoMessage("Slash commands", [
      ["/new", "start a new conversation"],
      ["/sessions", "browse past conversations"],
      ["/model", "switch model"],
      ["/status", "show provider, model, session"],
      ["/usage", "show token & cost totals"],
      ["/skill [name] [args]", "run a vault skill; args fill $ARGUMENTS/$1"],
      ["/help", "show this list"],
    ]);
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
    await this.service.newSession();
    this.attachments = [];
    this.resetUsageNotifications();
    this.renderChips();
    this.bubble = null;
    this.renderTranscript([]);
  }

  private resetUsageNotifications(): void {
    this.notifiedContext = new Set<number>();
    this.notifiedCost = false;
  }

  private async openSessionList(): Promise<void> {
    // Hide empty sessions — a conversation with no messages isn't worth listing.
    const sessions = (await this.service.listSessions()).filter((session) => session.messageCount > 0);
    new SessionListModal(this.app, sessions, this.service.getSessionInfo()?.path ?? null, {
      load: (session) => void this.loadSession(session.path),
      delete: (session) => this.service.deleteSession(session.path),
    }).open();
  }

  private async loadSession(path: string): Promise<void> {
    await this.service.loadSession(path);
    this.resetUsageNotifications();
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
      const models = (await listOpenRouterModels(settings.openrouterApiKey, { zdr: settings.privacy.requireZDR }))
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
    let rendered = 0;
    for (const message of messages) {
      if (message.role === "user") {
        this.renderUserMessage(messageText(message), []);
        rendered += 1;
      } else if (message.role === "assistant") {
        this.renderAssistantMessage(message, toolResults);
        rendered += 1;
      }
    }
    if (rendered === 0) this.renderEmptyState();
    this.scrollToBottom();
  }

  private renderAssistantMessage(message: AgentMessage, toolResults: Map<string, ToolResultLite>): void {
    const bubble = new AssistantBubble(this.messagesEl);
    const reasoning = thinkingText(message);
    if (reasoning) bubble.appendReasoning(reasoning);
    for (const call of toolCalls(message)) {
      bubble.startStep(call.id, call.name, JSON.stringify(call.arguments ?? {}));
      const result = toolResults.get(call.id);
      if (result) bubble.endStep(call.id, result.text, result.isError);
    }
    const text = messageText(message);
    if (text) void bubble.finalizeText(text, this.app, this);
    const usage = assistantUsage(message);
    if (usage) bubble.showUsage(usage);
  }

  private renderUserMessage(text: string, attachments: string[]): void {
    const el = this.messagesEl.createDiv({ cls: ["agentic-chat-message", "agentic-chat-user"] });
    if (attachments.length > 0) {
      const labels = attachments.map((entry) =>
        entry.startsWith(FOLDER_PREFIX) ? `${entry.slice(FOLDER_PREFIX.length)}/` : entry,
      );
      el.createDiv({ cls: "agentic-chat-user-attachments", text: `Attached: ${labels.join(", ")}` });
    }
    el.createDiv({ cls: "agentic-chat-user-text", text });
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
          this.bubble = new AssistantBubble(this.messagesEl);
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
    if (text) void bubble.finalizeText(text, this.app, this);
    const errorMessage = (message as { errorMessage?: string }).errorMessage;
    if (errorMessage) bubble.showError(errorMessage);
    const usage = assistantUsage(message);
    if (usage) bubble.showUsage(usage);
  }

  private ensureBubble(): AssistantBubble {
    if (!this.bubble) this.bubble = new AssistantBubble(this.messagesEl);
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

/** Owns the DOM of a single assistant turn: reasoning, tool steps, text, footer. */
class AssistantBubble {
  private readonly el: HTMLElement;
  private readonly stepsEl: HTMLElement;
  private readonly textEl: HTMLElement;
  private readonly footerEl: HTMLElement;
  private reasoningBody: HTMLElement | null = null;
  private readonly steps = new Map<string, { card: HTMLElement; icon: HTMLElement }>();

  constructor(parent: HTMLElement) {
    this.el = parent.createDiv({ cls: ["agentic-chat-message", "agentic-chat-assistant"] });
    this.stepsEl = this.el.createDiv({ cls: "agentic-chat-steps" });
    this.textEl = this.el.createDiv({ cls: ["agentic-chat-text", "is-streaming"] });
    this.footerEl = this.el.createDiv({ cls: "agentic-chat-footer" });
  }

  appendText(delta: string): void {
    this.textEl.appendText(delta);
  }

  appendReasoning(delta: string): void {
    if (!this.reasoningBody) {
      const details = this.el.createEl("details", { cls: "agentic-chat-reasoning" });
      details.createEl("summary", { text: "Reasoning" });
      this.reasoningBody = details.createDiv({ cls: "agentic-chat-reasoning-body" });
      this.el.insertBefore(details, this.stepsEl);
    }
    this.reasoningBody.appendText(delta);
  }

  startStep(id: string, name: string, rawArgs: string): void {
    const card = this.stepsEl.createDiv({ cls: ["agentic-chat-step", "is-running"] });
    const header = card.createDiv({ cls: "agentic-chat-step-header" });
    const icon = header.createSpan({ cls: "agentic-chat-step-icon" });
    setIcon(icon, "loader-2");
    header.createSpan({ cls: "agentic-chat-step-name", text: describeCall(name, rawArgs) });
    if (rawArgs && rawArgs !== "{}") {
      card.createEl("code", { cls: "agentic-chat-step-args", text: truncateText(rawArgs, 200) });
    }
    this.steps.set(id, { card, icon });
  }

  endStep(id: string, result: string, isError: boolean): void {
    const step = this.steps.get(id);
    if (!step) return;
    step.card.removeClass("is-running");
    step.card.addClass(isError ? "is-error" : "is-done");
    setIcon(step.icon, isError ? "x-circle" : "check-circle-2");
    const details = step.card.createEl("details", { cls: "agentic-chat-step-result" });
    details.createEl("summary", { text: isError ? "Error" : "Result" });
    details.createEl("pre", { text: truncateText(result, 4_000) });
  }

  async finalizeText(markdown: string, app: App, component: Component): Promise<void> {
    this.textEl.empty();
    this.textEl.removeClass("is-streaming");
    await MarkdownRenderer.render(app, markdown, this.textEl, "", component);
  }

  showError(message: string): void {
    const banner = this.el.createDiv({ cls: "agentic-chat-error" });
    banner.setText(message);
    this.el.insertBefore(banner, this.footerEl);
  }

  showUsage(usage: Usage): void {
    this.footerEl.setText(formatUsage(usage));
  }
}

const TOOL_LABELS: Record<string, string> = {
  read: "Reading file",
  write: "Writing file",
  edit: "Editing file",
  ls: "Listing folder",
  find: "Finding files",
  grep: "Searching",
  get_active_note: "Reading active note",
  rename: "Renaming",
  delete: "Deleting",
};

function describeCall(name: string, rawArgs: string): string {
  let detail = "";
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    const candidate = args.path ?? args.pattern ?? args.newPath;
    if (typeof candidate === "string") detail = candidate;
  } catch {
    // Arguments may be malformed; the label alone is still useful.
  }
  const label = TOOL_LABELS[name] ?? `Running ${name}`;
  return detail ? `${label}: ${detail}` : label;
}

// --- message extraction helpers (pi message shapes) ---

interface ToolResultLite {
  text: string;
  isError: boolean;
}

function collectToolResults(messages: AgentMessage[]): Map<string, ToolResultLite> {
  const map = new Map<string, ToolResultLite>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      map.set(message.toolCallId, { text: toolResultText(message), isError: message.isError });
    }
  }
  return map;
}

function contentBlocks(message: AgentMessage): Array<Record<string, unknown>> {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return contentBlocks(message)
    .filter((block) => block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
}

function thinkingText(message: AgentMessage): string {
  return contentBlocks(message)
    .filter((block) => block.type === "thinking")
    .map((block) => String(block.thinking ?? ""))
    .join("");
}

function toolCalls(message: AgentMessage): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  return contentBlocks(message)
    .filter((block) => block.type === "toolCall")
    .map((block) => ({
      id: String(block.id ?? ""),
      name: String(block.name ?? ""),
      arguments: (block.arguments as Record<string, unknown>) ?? {},
    }));
}

function toolResultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => (block as { type?: unknown }).type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("\n");
}

function assistantUsage(message: AgentMessage): Usage | undefined {
  const usage = (message as { usage?: Usage }).usage;
  return usage && usage.totalTokens > 0 ? usage : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function formatCost(total: number): string {
  if (!total) return "$0.00";
  return total < 0.01 ? `$${total.toFixed(4)}` : `$${total.toFixed(2)}`;
}

function formatUsage(usage: Usage): string {
  const total = usage.cost?.total ?? 0;
  const cost = total > 0 ? ` · ${formatCost(total)}` : "";
  return `${usage.totalTokens} tokens${cost}`;
}
