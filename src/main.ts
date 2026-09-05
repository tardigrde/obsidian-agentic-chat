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
import type { UserApprovalChoice } from "./agent/tool-call-controller";
import type { AskUserHandler } from "./tools/ask-user-tool";
import { createWindowE2EStreamFn } from "./agent/e2e-stream";
import { ToolArtifactStore } from "./artifacts/tool-artifact-store";
import {
  MCP_OAUTH_OBSIDIAN_PROTOCOL_ACTION,
  McpOAuthObsidianCallbackBridge,
  type McpOAuthCallbackReceiver,
} from "./mcp/oauth";
import { ObsidianSessionManager } from "./session/session-manager";
import { initPricingCache } from "./llm/pricing-cache";
import { ApprovalModal } from "./ui/approval-modal";
import { ChatView } from "./ui/chat-view";
import { buildQuickAskTarget } from "./ui/quick-ask";
import { QuickAskModal } from "./ui/quick-ask-modal";
import { ObsidianSecretStore, hydrateSettingsSecrets, settingsForStorage } from "./secrets/secret-store";
import { applyRememberedApprovalChoice } from "./agent/approval-memory";
import { PluginService } from "./plugins/service";
import { type AgentMode, resolveModeTransition, validateModeTransition } from "./agent/modes";
import { healPlanArtifact, type PlanArtifact } from "./agent/plan-artifact";

declare const __AGENTIC_CHAT_ENABLE_E2E_STREAM__: boolean;

export default class AgenticChatPlugin extends Plugin {
  settings: AgenticChatSettings = DEFAULT_SETTINGS;
  /**
   * S4: legacy single-source memory for plan restore. Plan posture memory now
   * lives per-session in the chat view (`PlanMemoryStore`); this field remains
   * only as a fallback for the no-open-view settings path. New code should
   * scope plan state to the session, not the plugin singleton.
   *
   * @deprecated Use the view's per-session plan memory instead.
   */
  modeBeforePlan: AgentMode | null = null;
  /** Persisted active plan artifacts by session key (`plans.json` in the plugin dir). */
  private planArtifacts: Record<string, PlanArtifact> | null = null;
  private lastSyncedMode: AgentMode | null = null;
  private secretStore!: ObsidianSecretStore;
  private readonly mcpOAuthCallbacks = new McpOAuthObsidianCallbackBridge();
  readonly pluginService = new PluginService(
    this.app,
    () => this.settings,
    () => this.saveSettings(),
  );

  async onload(): Promise<void> {
    this.secretStore = new ObsidianSecretStore(this.app);
    await this.loadSettings();
    initPricingCache(this.app, this);

    // Materialize the plugin's own skills and the user's empty skill collection
    // as editable Agent Plugins packages on first load (only when absent; never
    // overwrites edits). Sequential: both share the parent plugins folder, and
    // parallel ensures could race on its creation. Fire-and-forget: failures
    // must not block plugin startup.
    void (async () => {
      try {
        await this.pluginService.ensureBuiltinsMaterialized();
      } catch (error: unknown) {
        console.warn("Agentic chat: could not materialize built-in agent plugins", error);
      }
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
  createAgentService(options: { askUser?: AskUserHandler; confirmToolCall?: (request: ToolApprovalRequest) => Promise<UserApprovalChoice> } = {}): AgentService {
    const sessionManager = ObsidianSessionManager.forPlugin(this.app, this);
    return new AgentService({
      app: this.app,
      getSettings: () => this.settings,
      sessionManager,
      confirmToolCall: options.confirmToolCall ?? ((request) => this.confirmToolCall(request)),
      askUser: options.askUser,
      streamFn: createWindowE2EStreamFn({ enabled: __AGENTIC_CHAT_ENABLE_E2E_STREAM__ }),
      loopGuardDisabled: __AGENTIC_CHAT_ENABLE_E2E_STREAM__,
      saveSettings: () => this.saveSettings(),
      skillScaffolder: this.pluginService,
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

  /** Show the approval dialog and persist a remembered allow/deny choice after the user decides. */
  private async confirmToolCall(request: ToolApprovalRequest): Promise<UserApprovalChoice> {
    const choice = await new ApprovalModal(this.app, request).ask();
    if (applyRememberedApprovalChoice(this.settings, request.toolName, choice)) {
      await this.saveSettings();
    }
    return choice;
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
    // Capture legacy skills/templates folder settings BEFORE the first save
    // rewrites data.json in the new schema (mergeSettings drops those keys),
    // so the one-time migration below can preserve the user's skills.
    const legacySkillFolders = legacySkillFolderPaths(stored);
    this.settings = mergeSettings(stored);
    hydrateSettingsSecrets(this.settings, this.secretStore);
    // S4: remember mode for broadcast guard; heals plan restore on restart
    this.lastSyncedMode = this.settings.mode;
    if (legacySkillFolders.length > 0) {
      // Run the migration before persisting the new schema: if it fails we
      // skip the save, so data.json keeps the legacy keys and the migration
      // retries on the next load instead of permanently losing the user's
      // skills. Bounded one-time cost, only for configured legacy folders.
      const migrated = await this.tryMigrateLegacySkillFolders(legacySkillFolders);
      if (!migrated) return;
    }
    await this.saveSettings();
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
    await this.saveData(settingsForStorage(this.settings, this.secretStore));
    // Only broadcast when mode actually changed — avoids repaint + notification side-effects on unrelated saves.
    if (this.lastSyncedMode !== this.settings.mode) {
      this.lastSyncedMode = this.settings.mode;
      this.syncModeToViews();
    }
  }

  /** S4: single-source mode — after any persisted mode change, push chrome to every chat leaf atomically (Codex ThreadSettingsOverrides pattern). */
  private syncModeToViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT_CHAT)) {
      if (leaf.view instanceof ChatView) leaf.view.refreshModeFromSettings();
    }
  }

  /** Whether any chat view is currently streaming — used by the settings tab's atomic gate. */
  isAnyViewStreaming(): boolean {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT_CHAT)) {
      if (leaf.view instanceof ChatView && leaf.view.isStreaming()) return true;
    }
    return false;
  }

  /** Plugin-private file holding the active plan artifact per session. */
  private planArtifactsPath(): string {
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return `${dir}/plans.json`;
  }

  private async loadPlanArtifacts(): Promise<Record<string, PlanArtifact>> {
    if (this.planArtifacts) return this.planArtifacts;
    let parsed: Record<string, PlanArtifact> = {};
    try {
      if (await this.app.vault.adapter.exists(this.planArtifactsPath())) {
        const raw = await this.app.vault.adapter.read(this.planArtifactsPath());
        const value: unknown = JSON.parse(raw);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          parsed = {};
          for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            const healed = healPlanArtifact(entry);
            if (healed) parsed[key] = healed;
          }
        }
      }
    } catch {
      parsed = {};
    }
    this.planArtifacts = parsed;
    return parsed;
  }

  private async writePlanArtifacts(): Promise<void> {
    try {
      await this.app.vault.adapter.write(this.planArtifactsPath(), JSON.stringify(this.planArtifacts ?? {}));
    } catch (error) {
      console.warn("Agentic chat: could not persist plan artifacts", error);
    }
  }

  /** Active plan artifact for a session key (null when none or decided). */
  async getPlanArtifact(sessionKey: string): Promise<PlanArtifact | null> {
    const all = await this.loadPlanArtifacts();
    return all[sessionKey] ?? null;
  }

  /** Persist (or clear, with null) the active plan artifact for a session key. */
  async savePlanArtifact(sessionKey: string, artifact: PlanArtifact | null): Promise<void> {
    const all = await this.loadPlanArtifacts();
    if (artifact) all[sessionKey] = artifact;
    else delete all[sessionKey];
    await this.writePlanArtifacts();
  }

  /** S4: settings tab delegates to the active chat view so modeBeforePlan is handled atomically; falls back to direct mutate when no view is open. */
  async requestModeChange(target: AgentMode): Promise<boolean> {
    const activeView = this.app.workspace.getActiveViewOfType(ChatView);
    if (activeView) {
      const ok = await activeView.requestModeChange(target);
      if (!ok) {
        const blocked = validateModeTransition(
          this.settings.mode,
          target,
          this.isAnyViewStreaming(),
          this.modeBeforePlan,
        );
        if (blocked) new Notice(blocked);
      }
      return ok;
    }
    // No active view — mutate directly with the same validation as ChatView.
    const blocked = validateModeTransition(this.settings.mode, target, this.isAnyViewStreaming(), this.modeBeforePlan);
    if (blocked) {
      new Notice(blocked);
      return false;
    }
    if (this.settings.mode === target) return false;
    const transition = resolveModeTransition(this.settings.mode, target, this.modeBeforePlan);
    if (!transition) return false;
    this.settings.mode = transition.nextMode;
    this.modeBeforePlan = transition.nextPrevious;
    await this.saveSettings();
    return true;
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
