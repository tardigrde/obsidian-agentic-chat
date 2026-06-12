import { Plugin, WorkspaceLeaf } from "obsidian";
import {
  AgenticChatSettingTab,
  AgenticChatSettings,
  DEFAULT_SETTINGS,
} from "./settings";
import { ChatView, VIEW_TYPE_AGENT_CHAT } from "./ui/chat-view";

export default class AgenticChatPlugin extends Plugin {
  settings: AgenticChatSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_AGENT_CHAT, (leaf) => new ChatView(leaf, this));

    this.addRibbonIcon("messages-square", "Open agentic chat", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => void this.activateView(),
    });

    this.addSettingTab(new AgenticChatSettingTab(this.app, this));
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
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      privacy: { ...DEFAULT_SETTINGS.privacy, ...(stored?.privacy ?? {}) },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
