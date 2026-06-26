import {
  Plugin,
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
import { ObsidianSessionManager } from "./session/session-manager";
import { ApprovalModal } from "./ui/approval-modal";
import { ChatView } from "./ui/chat-view";
import { ObsidianSecretStore, hydrateSettingsSecrets, settingsForStorage } from "./secrets/secret-store";

declare const __AGENTIC_CHAT_ENABLE_E2E_STREAM__: boolean;

export default class AgenticChatPlugin extends Plugin {
  settings: AgenticChatSettings = DEFAULT_SETTINGS;
  private secretStore!: ObsidianSecretStore;

  async onload(): Promise<void> {
    this.secretStore = new ObsidianSecretStore(this.app);
    await this.loadSettings();

    this.registerView(VIEW_TYPE_AGENT_CHAT, (leaf) => new ChatView(leaf, this));

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

    this.registerContextMenus();
    this.addSettingTab(new AgenticChatSettingTab(this.app, this));
  }

  /**
   * Build a fresh agent service backed by its own session manager. The chat view
   * creates one per tab so multiple conversations can run independently in a leaf.
   */
  createAgentService(options: { askUser?: AskUserHandler } = {}): AgentService {
    const sessionManager = ObsidianSessionManager.forPlugin(this.app, this);
    return new AgentService({
      app: this.app,
      getSettings: () => this.settings,
      sessionManager,
      confirmToolCall: (request) => this.confirmToolCall(request),
      askUser: options.askUser,
      streamFn: createWindowE2EStreamFn({ enabled: __AGENTIC_CHAT_ENABLE_E2E_STREAM__ }),
      saveSettings: () => this.saveSettings(),
      artifactStore: ToolArtifactStore.forPlugin(this.app, this),
    });
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

  /** Show the approval dialog and persist a "remember" choice as a per-tool override. */
  private async confirmToolCall(request: ToolApprovalRequest): Promise<boolean> {
    const choice = await new ApprovalModal(this.app, request).ask();
    if (choice.approved && choice.remember) {
      this.settings.approval.perTool[request.toolName] = "allow";
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
