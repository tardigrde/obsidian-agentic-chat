import {
  Plugin,
  Notice,
  TFile,
  TFolder,
  WorkspaceLeaf,
  type Editor,
  type MarkdownFileInfo,
  type MarkdownView,
  type Menu,
  type TAbstractFile,
} from "obsidian";
import { VIEW_TYPE_AGENT_CHAT } from "./constants";
import {
  AgenticChatSettingTab,
  type AgenticChatSettings,
  DEFAULT_SETTINGS,
  mergeSettings,
} from "./settings";
import { AgentService, type ToolApprovalRequest } from "./agent/agent-service";
import type { AskUserHandler } from "./tools/ask-user-tool";
import { createWindowE2EStreamFn } from "./agent/e2e-stream";
import { ToolArtifactStore } from "./artifacts/tool-artifact-store";
import {
  MCP_OAUTH_OBSIDIAN_PROTOCOL_ACTION,
  McpOAuthObsidianCallbackBridge,
  type McpOAuthCallbackReceiver,
} from "./mcp/oauth";
import { ObsidianSessionManager } from "./session/session-manager";
import { ApprovalModal } from "./ui/approval-modal";
import { ChatView } from "./ui/chat-view";
import { buildQuickAskTarget } from "./ui/quick-ask";
import { QuickAskModal } from "./ui/quick-ask-modal";
import { ObsidianSecretStore, hydrateSettingsSecrets, settingsForStorage } from "./secrets/secret-store";
import { effectiveProjectSettings, projectSessionScope } from "./projects/projects";
import { applyRememberedApprovalChoice } from "./agent/approval-memory";
import { firstExternalReference, openExternalReference } from "./tools/external-workspace";

declare const __AGENTIC_CHAT_ENABLE_E2E_STREAM__: boolean;

export default class AgenticChatPlugin extends Plugin {
  settings: AgenticChatSettings = DEFAULT_SETTINGS;
  private secretStore!: ObsidianSecretStore;
  private readonly mcpOAuthCallbacks = new McpOAuthObsidianCallbackBridge();

  async onload(): Promise<void> {
    this.secretStore = new ObsidianSecretStore(this.app);
    await this.loadSettings();

    this.registerView(VIEW_TYPE_AGENT_CHAT, (leaf) => new ChatView(leaf, this));
    this.registerObsidianProtocolHandler(MCP_OAUTH_OBSIDIAN_PROTOCOL_ACTION, (params) => {
      if (!this.mcpOAuthCallbacks.handleProtocolCallback(params)) {
        new Notice("Agentic Chat MCP OAuth: no sign-in flow is waiting for this callback.");
      }
    });

    this.addRibbonIcon("messages-square", "Open agentic chat", () => void this.activateView());

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "new-conversation",
      name: "New conversation",
      callback: () => void this.runOnActiveView((view) => view.startNewConversation()),
    });

    this.addCommand({
      id: "quick-ask-inline-edit",
      name: "Quick Ask inline edit",
      editorCallback: (editor, info) => this.openQuickAskInlineEdit(editor, info),
    });

    this.addCommand({
      id: "open-selected-external-reference",
      name: "Open selected external:// reference",
      editorCallback: (editor) => void this.openSelectedExternalReference(editor),
    });

    this.registerContextMenus();
    this.addSettingTab(new AgenticChatSettingTab(this.app, this));
  }

  /**
   * Build a fresh agent service backed by its own session manager. The chat view
   * creates one per tab so multiple conversations can run independently in a leaf.
   */
  createAgentService(options: { askUser?: AskUserHandler } = {}): AgentService {
    const sessionManager = ObsidianSessionManager.forPlugin(this.app, this, () =>
      projectSessionScope(this.settings.projects),
    );
    return new AgentService({
      app: this.app,
      getSettings: () => effectiveProjectSettings(this.settings),
      sessionManager,
      confirmToolCall: (request) => this.confirmToolCall(request),
      askUser: options.askUser,
      streamFn: createWindowE2EStreamFn({ enabled: __AGENTIC_CHAT_ENABLE_E2E_STREAM__ }),
      saveSettings: () => this.saveSettings(),
      artifactStore: ToolArtifactStore.forPlugin(this.app, this, {
        referencedArtifactIds: () => sessionManager.listReferencedArtifactIds(),
      }),
    });
  }

  createMcpOAuthCallbackReceiver(): McpOAuthCallbackReceiver {
    return this.mcpOAuthCallbacks.createReceiver();
  }

  /** Reveal the chat view, then run `fn` against it (commands act on the active view). */
  private async runOnActiveView(fn: (view: ChatView) => void | Promise<void>): Promise<void> {
    await this.activateView();
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT_CHAT)[0];
    if (leaf?.view instanceof ChatView) await fn(leaf.view);
  }

  private registerContextMenus(): void {
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor, info) => {
        this.addEditorSelectionMenuItem(menu, editor, info);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        this.addVaultEntryMenuItem(menu, [file]);
      }),
    );
    this.registerEvent(
      this.app.workspace.on("files-menu", (menu, files) => {
        this.addVaultEntryMenuItem(menu, files);
      }),
    );
  }

  private addEditorSelectionMenuItem(
    menu: Menu,
    editor: Editor,
    info: MarkdownView | MarkdownFileInfo,
  ): void {
    const selection = editor.getSelection().trim();
    if (!selection) return;
    const sourcePath = info.file?.path;
    menu.addItem((item) =>
      item
        .setTitle("Send selection to Agentic Chat")
        .setIcon("messages-square")
        .onClick(() => void this.runOnActiveView((view) => view.attachSelectionFromMenu(selection, sourcePath))),
    );
  }

  private addVaultEntryMenuItem(menu: Menu, files: TAbstractFile[]): void {
    const entries = files.filter((file): file is TFile | TFolder => file instanceof TFile || file instanceof TFolder);
    if (entries.length === 0) return;
    menu.addItem((item) =>
      item
        .setTitle(entries.length === 1 ? "Send to Agentic Chat" : "Send files to Agentic Chat")
        .setIcon("messages-square")
        .onClick(
          () =>
            void this.runOnActiveView((view) => {
              for (const entry of entries) view.attachVaultEntryFromMenu(entry);
            }),
        ),
    );
  }

  private openQuickAskInlineEdit(editor: Editor, info: MarkdownView | MarkdownFileInfo): void {
    const target = buildQuickAskTarget(editor, info.file?.path);
    if (target.text.length === 0 && target.kind === "line") {
      new Notice("No editor text selected.");
      return;
    }
    new QuickAskModal(this.app, target, (proposal) => {
      editor.replaceRange(proposal.replacement, proposal.target.from, proposal.target.to);
    }).open();
  }

  private async openSelectedExternalReference(editor: Editor): Promise<void> {
    const selection = editor.getSelection().trim();
    const cursor = editor.getCursor();
    const line = selection || editor.getLine(cursor.line);
    const reference = firstExternalReference(line, selection ? undefined : cursor.ch);
    if (!reference) {
      new Notice("Select or place the cursor on an external:// reference.");
      return;
    }
    try {
      const message = await openExternalReference(this.settings.external, reference);
      new Notice(message);
    } catch (error) {
      new Notice(`Agentic Chat: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Show the approval dialog and persist a remembered allow/deny choice after the user decides. */
  private async confirmToolCall(request: ToolApprovalRequest): Promise<boolean> {
    const choice = await new ApprovalModal(this.app, request).ask();
    if (applyRememberedApprovalChoice(this.settings, request.toolName, choice)) {
      await this.saveSettings();
    }
    return choice.approved;
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_AGENT_CHAT);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: VIEW_TYPE_AGENT_CHAT, active: true });
    }
    await workspace.revealLeaf(leaf);
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<AgenticChatSettings> | null;
    this.settings = mergeSettings(stored);
    hydrateSettingsSecrets(this.settings, this.secretStore);
    await this.saveSettings();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(settingsForStorage(this.settings, this.secretStore));
  }
}
