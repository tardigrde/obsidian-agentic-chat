import {
  App,
  Component,
  ItemView,
  MarkdownRenderer,
  Notice,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type AgenticChatPlugin from "../main";
import { Agent } from "../agent/agent";
import type { AgentEvent, ChatMessage, Usage } from "../agent/types";
import { OpenRouterModel } from "../llm/openrouter";
import { VaultDeps, vaultTools } from "../tools/vault-tools";
import { ConversationStore } from "../state/conversation";
import { FolderSuggestModal } from "./folder-suggest";

export const VIEW_TYPE_AGENT_CHAT = "agentic-chat-view";

const FOLDER_PREFIX = "folder:";

const TOOL_LABELS: Record<string, string> = {
  read_note: "Reading note",
  write_note: "Writing note",
  list_folder: "Listing folder",
  search_vault: "Searching vault",
  get_active_note: "Reading active note",
};

function describeCall(name: string, rawArgs: string): string {
  let detail = "";
  try {
    const args = JSON.parse(rawArgs) as Record<string, unknown>;
    const candidate = args.path ?? args.query;
    if (typeof candidate === "string") detail = candidate;
  } catch {
    // Arguments may be malformed; the label alone is still useful.
  }
  const label = TOOL_LABELS[name] ?? `Running ${name}`;
  return detail ? `${label}: ${detail}` : label;
}

function truncateText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export class ChatView extends ItemView {
  private readonly store = new ConversationStore();
  private history: ChatMessage[] = [];
  private attachments: string[] = [];
  private abortController: AbortController | null = null;
  private running = false;

  private messagesEl!: HTMLElement;
  private emptyStateEl: HTMLElement | null = null;
  private chipsEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private bubble: AssistantBubble | null = null;

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

  async onOpen(): Promise<void> {
    this.buildLayout();
  }

  async onClose(): Promise<void> {
    this.abortController?.abort();
  }

  private buildLayout(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("agentic-chat-view");

    const header = root.createDiv({ cls: "agentic-chat-header" });
    header.createDiv({ cls: "agentic-chat-title", text: "Agentic chat" });
    const actions = header.createDiv({ cls: "agentic-chat-header-actions" });
    const newChatButton = actions.createEl("button", {
      cls: "clickable-icon",
      attr: { "aria-label": "New chat" },
    });
    setIcon(newChatButton, "plus");
    newChatButton.addEventListener("click", () => this.resetChat());

    this.messagesEl = root.createDiv({ cls: "agentic-chat-messages" });
    this.renderEmptyState();

    const composer = root.createDiv({ cls: "agentic-chat-composer" });
    this.chipsEl = composer.createDiv({ cls: "agentic-chat-chips" });
    this.inputEl = composer.createEl("textarea", {
      cls: "agentic-chat-input",
      attr: { rows: "3", placeholder: "Ask the agent about your vault… (Enter to send)" },
    });
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.sendMessage();
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
      new FolderSuggestModal(this.app, (folder) =>
        this.addAttachment(`${FOLDER_PREFIX}${folder.path}`),
      ).open();
    });

    this.statusEl = buttonRow.createDiv({ cls: "agentic-chat-status" });
    this.stopButton = buttonRow.createEl("button", {
      cls: ["agentic-chat-stop", "mod-warning"],
      text: "Stop",
    });
    this.stopButton.hide();
    this.stopButton.addEventListener("click", () => this.abortController?.abort());
    this.sendButton = buttonRow.createEl("button", { cls: "mod-cta", text: "Send" });
    this.sendButton.addEventListener("click", () => void this.sendMessage());
  }

  private renderEmptyState(): void {
    this.emptyStateEl = this.messagesEl.createDiv({ cls: "agentic-chat-empty" });
    const icon = this.emptyStateEl.createDiv({ cls: "agentic-chat-empty-icon" });
    setIcon(icon, "bot");
    this.emptyStateEl.createDiv({
      cls: "agentic-chat-empty-text",
      text: "Ask anything about your vault. The agent can read, search, list, and write notes — every tool call is shown inline.",
    });
  }

  private clearEmptyState(): void {
    this.emptyStateEl?.detach();
    this.emptyStateEl = null;
  }

  private resetChat(): void {
    this.abortController?.abort();
    this.store.reset();
    this.history = [];
    this.attachments = [];
    this.bubble = null;
    this.renderChips();
    this.messagesEl.empty();
    this.renderEmptyState();
    this.statusEl.setText("");
  }

  private attachActiveNote(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Agentic chat: no active note to attach.");
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
      chip.createSpan({
        text: entry.startsWith(FOLDER_PREFIX) ? entry.slice(FOLDER_PREFIX.length) : entry,
      });
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
        const folder =
          folderPath === "/"
            ? this.app.vault.getRoot()
            : this.app.vault.getAbstractFileByPath(folderPath);
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

  private async sendMessage(): Promise<void> {
    if (this.running) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    const settings = this.plugin.settings;
    if (!settings.apiKey) {
      new Notice("Agentic chat: set your OpenRouter API key in the plugin settings first.");
      return;
    }

    this.clearEmptyState();
    const attachments = [...this.attachments];
    const context = await this.buildContext();
    const prompt = context ? `${context}\n\n${text}` : text;

    this.inputEl.value = "";
    this.store.addUser(text, attachments);
    this.renderUserMessage(text, attachments);

    this.store.beginAssistant();
    this.bubble = new AssistantBubble(this.messagesEl);
    this.setRunning(true);
    this.abortController = new AbortController();

    const model = new OpenRouterModel({
      apiKey: settings.apiKey,
      model: settings.model,
      privacy: settings.privacy,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens > 0 ? settings.maxTokens : undefined,
      requestTimeoutMs: settings.requestTimeoutMs,
      maxRetries: settings.maxNetworkRetries,
    });
    const agent = new Agent<VaultDeps>({
      model,
      systemPrompt: settings.systemPrompt,
      tools: vaultTools(),
      maxSteps: settings.maxSteps,
    });

    try {
      const result = await agent.run(prompt, {
        deps: { app: this.app },
        history: this.history,
        signal: this.abortController.signal,
        onEvent: (event) => this.handleAgentEvent(event),
      });
      this.history = result.messages;
    } catch (error) {
      if (this.abortController?.signal.aborted) {
        this.store.markStopped();
      } else {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Agentic chat: ${message}`);
      }
    } finally {
      this.setRunning(false);
      this.abortController = null;
      this.statusEl.setText("");
      await this.finalizeBubble();
    }
  }

  private renderUserMessage(text: string, attachments: string[]): void {
    const el = this.messagesEl.createDiv({
      cls: ["agentic-chat-message", "agentic-chat-user"],
    });
    if (attachments.length > 0) {
      const labels = attachments.map((entry) =>
        entry.startsWith(FOLDER_PREFIX) ? `${entry.slice(FOLDER_PREFIX.length)}/` : entry,
      );
      el.createDiv({
        cls: "agentic-chat-user-attachments",
        text: `Attached: ${labels.join(", ")}`,
      });
    }
    el.createDiv({ cls: "agentic-chat-user-text", text });
    this.scrollToBottom();
  }

  private handleAgentEvent(event: AgentEvent): void {
    this.store.applyAgentEvent(event);
    const bubble = this.bubble;
    if (!bubble) return;
    switch (event.type) {
      case "step_start":
        this.statusEl.setText(event.step === 1 ? "Thinking…" : `Working — step ${event.step}…`);
        break;
      case "text_delta":
        bubble.appendText(event.delta);
        break;
      case "reasoning_delta":
        bubble.appendReasoning(event.delta);
        break;
      case "tool_call_start":
        bubble.startStep(event.id, event.name, event.arguments);
        break;
      case "tool_call_end":
        bubble.endStep(event.id, event.result, event.isError);
        break;
      case "run_start":
      case "run_end":
      case "run_error":
        break;
    }
    this.scrollToBottom();
  }

  private async finalizeBubble(): Promise<void> {
    const bubble = this.bubble;
    const item = this.store.lastAssistant;
    if (!bubble || !item) return;
    if (item.status === "error" && item.error) {
      bubble.showError(item.error);
    } else if (item.status === "stopped") {
      bubble.showError("Stopped by user.");
    }
    if (item.text) {
      await bubble.finalizeText(item.text, this.app, this);
    }
    if (item.status === "done" && item.usage) {
      bubble.showUsage(item.usage, this.plugin.settings.model);
    }
    this.bubble = null;
    this.scrollToBottom();
  }

  private setRunning(running: boolean): void {
    this.running = running;
    this.sendButton.disabled = running;
    if (running) {
      this.stopButton.show();
    } else {
      this.stopButton.hide();
    }
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
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
      card.createEl("code", {
        cls: "agentic-chat-step-args",
        text: truncateText(rawArgs, 200),
      });
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

  showUsage(usage: Usage, modelId: string): void {
    this.footerEl.setText(
      `${modelId} · ${usage.totalTokens} tokens · ${usage.requests} request${usage.requests === 1 ? "" : "s"}`,
    );
  }
}
