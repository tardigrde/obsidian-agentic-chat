import {
  Platform,
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
import { AgenticChatSettingTab } from "./settings";
import {
  type AgenticChatSettings,
  DEFAULT_SETTINGS,
  mergeSettings,
  retiredSettingsNotices,
  SettingsVersionError,
} from "./settings-schema";
import { AgentService, type ToolApprovalRequest } from "./agent/agent-service";
import type { UserApprovalChoice } from "./agent/tool-call-controller";
import type { AskUserHandler } from "./tools/ask-user-tool";
import { createWindowE2EStreamFn } from "./agent/e2e-stream";
import { ToolArtifactStore } from "./artifacts/tool-artifact-store";
import {
  MCP_OAUTH_OBSIDIAN_PROTOCOL_ACTION,
  McpOAuthObsidianCallbackBridge,
  type McpOAuthCallbackReceiver,
} from "./mcp/oauth";
import { ObsidianSessionManager, SessionWriteRegistry } from "./session/session-manager";
import { initPricingCache } from "./llm/pricing-cache";
import { shouldCollapseLeftSidebar } from "./ui/chat-placement";
import { ChatView } from "./ui/chat-view";
import { buildQuickAskTarget } from "./ui/quick-ask";
import { QuickAskModal } from "./ui/quick-ask-modal";
import { ObsidianSecretStore, hydrateSettingsSecrets, settingsForStorage } from "./secrets/secret-store";
import { migrateLegacyPlaintextSecrets, withUnmigratedSecrets } from "./secrets/legacy-plaintext";
import { PluginService } from "./plugins/service";
import { type AgentMode, DEFAULT_MODE, resolveModeTransition, validateModeTransition } from "./agent/modes";
import { SettingsStore } from "./settings-store";

declare const __AGENTIC_CHAT_ENABLE_E2E_STREAM__: boolean;

export default class AgenticChatPlugin extends Plugin {
  /** The same object the settings store owns; both change only through the store. */
  settings: AgenticChatSettings = DEFAULT_SETTINGS;
  /** Session posture shared by every chat view. Runtime only: never saved. */
  private runtimeMode: AgentMode = DEFAULT_MODE;
  private readonly modeListeners = new Set<(mode: AgentMode) => void>();
  /** False when data.json belongs to a newer build; saves must not overwrite it. */
  private settingsWritable = true;
  private secretStore!: ObsidianSecretStore;
  private readonly sessionWriteRegistry = new SessionWriteRegistry();
  private readonly mcpOAuthCallbacks = new McpOAuthObsidianCallbackBridge();
  readonly settingsStore = new SettingsStore(DEFAULT_SETTINGS, (settings) => this.persistSettings(settings));
  readonly pluginService = new PluginService(
    this.app,
    () => this.settings,
    () => this.saveSettings(),
  );

  async onload(): Promise<void> {
    this.secretStore = new ObsidianSecretStore(this.app);
    await this.loadSettings();
    // Recover an interrupted package install before any turn can load plugins:
    // a retained backup must own the settings readers use.
    try {
      await this.pluginService.sweepImportStages();
    } catch (error: unknown) {
      console.warn("Agentic chat: could not sweep interrupted plugin imports", error);
    }
    initPricingCache(this.app, this);

    // Materialize the user's empty skill collection on first load (only when
    // absent; never overwrites edits). Built-in skills are served from the
    // plugin code and never copied to the vault (U4 #12): an upgrade always
    // ships their current text, and a vault skill of the same name overrides.
    // Fire-and-forget: failures must not block plugin startup.
    void (async () => {
      try {
        await this.pluginService.ensureMySkillsMaterialized();
      } catch (error: unknown) {
        console.warn("Agentic chat: could not materialize the user skill collection", error);
      }
    })();

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

    this.registerContextMenus();
    this.addSettingTab(new AgenticChatSettingTab(this.app, this));

    // Vault edits touching the plugins folder invalidate the plugin cache so
    // the settings tab and /doctor re-scan on the next render instead of
    // showing a stale tree (external sync, hand-edited manifests).
    const invalidateFor = (file: { path: string }) => this.pluginService.invalidateFor(file.path);
    this.registerEvent(this.app.vault.on("modify", invalidateFor));
    this.registerEvent(this.app.vault.on("create", invalidateFor));
    this.registerEvent(this.app.vault.on("delete", invalidateFor));
    this.registerEvent(this.app.vault.on("rename", invalidateFor));
  }

  /**
   * Build a fresh agent service backed by its own session manager. The chat view
   * creates one per tab so multiple conversations can run independently in a leaf.
   */
  createAgentService(options: {
    askUser?: AskUserHandler;
    confirmToolCall?: (request: ToolApprovalRequest, signal?: AbortSignal) => Promise<UserApprovalChoice>;
  } = {}): AgentService {
    const sessionManager = ObsidianSessionManager.forPlugin(this.app, this, this.sessionWriteRegistry);
    return new AgentService({
      app: this.app,
      getSettings: () => this.settings,
      getMode: () => this.mode,
      sessionManager,
      confirmToolCall: options.confirmToolCall ?? ((request) => this.denyWithoutChatView(request)),
      askUser: options.askUser,
      streamFn: createWindowE2EStreamFn({ enabled: __AGENTIC_CHAT_ENABLE_E2E_STREAM__ }),
      loopGuardDisabled: __AGENTIC_CHAT_ENABLE_E2E_STREAM__,
      saveSettings: () => this.saveSettings(),
      pluginService: this.pluginService,
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

  /**
   * Approvals render inline in the chat tab that asked. A service built
   * without a chat view has no place to ask, so the call is denied.
   */
  private async denyWithoutChatView(request: ToolApprovalRequest): Promise<UserApprovalChoice> {
    return { approved: false, remember: false, reason: `No chat view is open to approve "${request.label}".` };
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
    // A narrow desktop window cannot hold both sidebars: make room for the chat.
    if (shouldCollapseLeftSidebar(window.innerWidth, Platform.isMobile, workspace.leftSplit.collapsed)) {
      workspace.leftSplit.collapse();
    }
    await workspace.revealLeaf(leaf);
    workspace.setActiveLeaf(leaf, { focus: true });
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<AgenticChatSettings> | null;
    // Capture legacy skills/templates folder settings BEFORE the first save
    // rewrites data.json in the new schema (mergeSettings drops those keys),
    // so the one-time migration below can preserve the user's skills.
    const legacySkillFolders = legacySkillFolderPaths(stored);
    // Move any pre-secretStorage plaintext credentials into the secret store
    // once, before mergeSettings reads the persisted shape. The legacy keys are
    // deleted from the stored object, so no plaintext fallback reaches runtime
    // settings and the next save cannot write them back to data.json. A value
    // the store refuses stays in memory for this session only.
    const unmigrated = migrateLegacyPlaintextSecrets(stored, this.secretStore);
    if (unmigrated.length > 0) {
      console.warn("Agentic chat: could not move legacy secrets to secure storage", unmigrated.map((f) => f.error));
      new Notice("Could not move your API key to secure storage; it is kept in memory for this session");
    }
    // Read what THIS data.json still carries before mergeSettings drops it, so
    // the user learns which retired settings changed behaviour on upgrade.
    const retiredNotices = retiredSettingsNotices(stored);
    try {
      this.settings = mergeSettings(stored);
    } catch (error) {
      if (!(error instanceof SettingsVersionError)) throw error;
      // The format is newer than this build. Run on defaults in memory, but do
      // not save: the user's file must survive to be opened by the newer build.
      this.settings = structuredClone(DEFAULT_SETTINGS);
      this.settingsStore.replace(this.settings);
      this.settingsWritable = false;
      new Notice(error.message);
      console.warn(`Agentic chat: ${error.message}`);
      return;
    }
    this.settingsStore.replace(this.settings);
    hydrateSettingsSecrets(this.settings, withUnmigratedSecrets(this.secretStore, unmigrated));
    if (legacySkillFolders.length > 0) {
      // Run the migration before persisting the new schema: if it fails we
      // skip the save, so data.json keeps the legacy keys and the migration
      // retries on the next load instead of permanently losing the user's
      // skills. Bounded one-time cost, only for configured legacy folders.
      const migrated = await this.tryMigrateLegacySkillFolders(legacySkillFolders);
      if (!migrated) return;
    }
    if (unmigrated.length === 0) {
      await this.saveSettings();
    } else {
      // The store already refused a write; a failing save must not block load.
      // settingsForStorage never emits plaintext, so nothing leaks to data.json.
      try {
        await this.saveSettings();
      } catch (error) {
        console.warn("Agentic chat: could not save settings after secret migration failure", error);
      }
    }
    // Shown once: the save above rewrites data.json without the retired keys.
    if (retiredNotices.length > 0) {
      new Notice(`Agentic Chat: ${retiredNotices.join(" ")}`, 0);
    }
  }

  /** Best-effort one-time migration of pre-plugins skills folders. Returns false when it failed and should be retried. */
  private async tryMigrateLegacySkillFolders(folders: string[]): Promise<boolean> {
    try {
      const created = await this.pluginService.materializeLegacySkills(folders);
      if (created) {
        new Notice(
          "Agentic Chat: migrated your Skills/Templates folders into an editable 'legacy-skills' plugin package.",
        );
      }
      return true;
    } catch (error) {
      console.warn("Agentic chat: could not migrate legacy skills folders", error);
      return false;
    }
  }

  async saveSettings(): Promise<void> {
    await this.settingsStore.save();
  }

  private async persistSettings(settings: AgenticChatSettings): Promise<void> {
    if (!this.settingsWritable) {
      throw new Error("Settings were written by a newer version of Agentic Chat; update the plugin to change them.");
    }
    await this.saveData(settingsForStorage(settings, this.secretStore));
  }

  /** The shared runtime mode, read by every chat view and every agent service. */
  get mode(): AgentMode {
    return this.runtimeMode;
  }

  /**
   * One runtime posture for every view. Safe at each start; a settings save or
   * an unrelated settings change never writes it. Callers validate streaming
   * before asking; the returned false means no change landed.
   */
  setMode(target: AgentMode): boolean {
    const blocked = validateModeTransition(this.isAnyViewStreaming());
    if (blocked || this.runtimeMode === target) return false;
    const transition = resolveModeTransition(this.runtimeMode, target);
    if (!transition) return false;
    this.runtimeMode = transition.nextMode;
    this.syncModeToViews();
    for (const listener of [...this.modeListeners]) {
      try {
        listener(this.runtimeMode);
      } catch (error: unknown) {
        console.warn("Agentic chat: mode change listener failed", error);
      }
    }
    return true;
  }

  /** Subscribe to runtime Safe ↔ YOLO changes. Returns an unsubscribe function. */
  onModeChange(listener: (mode: AgentMode) => void): () => void {
    this.modeListeners.add(listener);
    return () => {
      this.modeListeners.delete(listener);
    };
  }

  /** Push the shared runtime mode into chrome on every chat leaf. */
  private syncModeToViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT_CHAT)) {
      if (leaf.view instanceof ChatView) leaf.view.refreshModeFromSettings();
    }
  }

  /** Whether any chat view is currently streaming — the mode transition gate. */
  isAnyViewStreaming(): boolean {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT_CHAT)) {
      if (leaf.view instanceof ChatView && leaf.view.isStreaming()) return true;
    }
    return false;
  }
}

/** Raw legacy skills/templates folder values from pre-plugins stored settings. */
function legacySkillFolderPaths(stored: Partial<AgenticChatSettings> | null | undefined): string[] {
  if (!stored || typeof stored !== "object") return [];
  const raw = stored as unknown as Record<string, unknown>;
  const folders: string[] = [];
  for (const key of ["skillsFolder", "templatesFolder"]) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) folders.push(value.trim());
  }
  return folders;
}
