import { Plugin, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_AGENT_CHAT } from "./constants";
import {
  AgenticChatSettingTab,
  type AgenticChatSettings,
  DEFAULT_SETTINGS,
  mergeSettings,
} from "./settings";
import { AgentService, type ToolApprovalRequest } from "./agent/agent-service";
import { ObsidianSessionManager } from "./session/session-manager";
import { ApprovalModal } from "./ui/approval-modal";
import { ChatView } from "./ui/chat-view";

export default class AgenticChatPlugin extends Plugin {
  settings: AgenticChatSettings = DEFAULT_SETTINGS;
  agentService!: AgentService;

  async onload(): Promise<void> {
    await this.loadSettings();

    const sessionManager = ObsidianSessionManager.forPlugin(this.app, this);
    this.agentService = new AgentService({
      app: this.app,
      getSettings: () => this.settings,
      sessionManager,
      confirmToolCall: (request) => this.confirmToolCall(request),
    });

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
      callback: () => void this.agentService.newSession(),
    });

    this.addSettingTab(new AgenticChatSettingTab(this.app, this));
  }

  onunload(): void {
    this.agentService?.dispose();
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
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<AgenticChatSettings> | null;
    this.settings = mergeSettings(stored);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
