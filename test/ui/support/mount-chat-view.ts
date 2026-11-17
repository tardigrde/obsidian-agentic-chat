import type { App, DataAdapter, TFile } from "obsidian";
import { WorkspaceLeaf } from "./obsidian-dom";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { AgentService } from "../../../src/agent/agent-service";
import type { ToolApprovalRequest, UserApprovalChoice } from "../../../src/agent/tool-call-controller";
import { createReplayStreamController, type ReplayTurn } from "../../../src/agent/replay-stream";
import type AgenticChatPlugin from "../../../src/main";
import { ObsidianSessionManager, SessionWriteRegistry } from "../../../src/session/session-manager";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../../../src/settings-schema";
import { SettingsStore } from "../../../src/settings-store";
import type { AskUserHandler } from "../../../src/tools/ask-user-tool";
import { ChatView } from "../../../src/ui/chat-view";
import { FakeVault } from "../../helpers/fake-vault";
import { FakeAdapter } from "../../support/fake-adapter";

type Handler = (...args: unknown[]) => void;

/** A minimal event bus with Obsidian's `on` / `offref` / `trigger` shape. */
class Events {
  private readonly handlers = new Map<string, Set<Handler>>();
  on(name: string, handler: Handler): { off: () => void } {
    const set = this.handlers.get(name) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(name, set);
    return { off: () => set.delete(handler) };
  }
  offref(ref: { off: () => void }): void {
    ref.off();
  }
  trigger(name: string, ...args: unknown[]): void {
    for (const handler of [...(this.handlers.get(name) ?? [])]) handler(...args);
  }
}

export interface FakeApp {
  app: App;
  vault: FakeVault;
  workspace: Events & {
    activeFile: TFile | null;
    opened: string[];
    activeView: unknown;
  };
}

/** A FakeVault-backed App with the workspace members the chat view reads. */
export function fakeApp(): FakeApp {
  const vault = new FakeVault();
  const vaultEvents = new Events();
  const vaultApi = Object.assign(vault, {
    on: vaultEvents.on.bind(vaultEvents),
    offref: vaultEvents.offref.bind(vaultEvents),
    trigger: vaultEvents.trigger.bind(vaultEvents),
    getName: () => "ui-test-vault",
    configDir: ".obsidian",
    getResourcePath: (file: TFile) => `app://local/${encodeURI(file.path)}`,
  });
  const workspace = Object.assign(new Events(), {
    activeFile: null as TFile | null,
    opened: [] as string[],
    activeView: null as unknown,
  });
  const workspaceApi = Object.assign(workspace, {
    getActiveFile: () => workspace.activeFile,
    getActiveViewOfType: (type: new (...args: never[]) => unknown) =>
      workspace.activeView instanceof type ? workspace.activeView : null,
    getLeavesOfType: () => [],
    openLinkText: async (target: string) => {
      workspace.opened.push(target);
      const file = vault.getFileByPath(target);
      if (file) workspace.activeFile = file;
    },
  });
  const metadataCache = {
    getFirstLinkpathDest: (linkpath: string) =>
      vault.getFiles().find((file) => file.path === linkpath || file.name === linkpath) ?? null,
  };
  const app = { vault: vaultApi, workspace: workspaceApi, metadataCache } as unknown as App;
  return { app, vault, workspace };
}

export interface MountOptions {
  /** Scripted model turns, in order, shared by every tab's service. */
  turns?: ReplayTurn[];
  settings?: Partial<AgenticChatSettings>;
  /** Answer each tool approval without a modal. Default: open the real ApprovalModal. */
  approve?: (request: ToolApprovalRequest) => Promise<UserApprovalChoice>;
  /** Resolve a `hold: true` turn. Default: release at once. */
  waitForRelease?: () => Promise<void>;
}

export interface MountedChatView {
  view: ChatView;
  app: FakeApp;
  plugin: AgenticChatPlugin;
  settings: AgenticChatSettings;
  /** The data adapter that holds session files (`sessions/*.jsonl`). */
  adapter: DataAdapter;
  /** Every scripted model call so far. */
  calls: () => number;
  /** The view root (`.agentic-chat-view`). */
  root: HTMLElement;
  /** Inject one agent event, as the e2e render specs did through the page. */
  emit: (event: Record<string, unknown>) => void;
  $: <T extends Element = HTMLElement>(selector: string) => T | null;
  $$: <T extends Element = HTMLElement>(selector: string) => T[];
  /** Type into the composer and press Enter (sends when idle, steers while streaming). */
  send: (text: string) => Promise<void>;
  /** Type into the composer and click the Send/Queue button (queues while streaming). */
  queue: (text: string) => Promise<void>;
  /** Resolve when the active tab is idle (no stream, no pending work). */
  idle: () => Promise<void>;
  close: () => Promise<void>;
}

/** Run queued microtasks and zero-delay timers until the DOM stops changing. */
export async function settle(rounds = 20): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Mount the real ChatView (real tabs, composer, turn controller, transcript,
 * and AgentService) in happy-dom. Only the model is scripted.
 */
export async function mountChatView(options: MountOptions = {}): Promise<MountedChatView> {
  const fake = fakeApp();
  const settings: AgenticChatSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    openrouterApiKey: "test-key",
    ...options.settings,
  };
  const settingsStore = new SettingsStore(settings, async () => {});
  const registry = new SessionWriteRegistry();
  const adapter = new FakeAdapter().asDataAdapter();
  const replay = createReplayStreamController(options.turns ?? [], {
    missingTurn: "error",
    waitForRelease: options.waitForRelease,
  });
  const views: ChatView[] = [];

  const plugin = {
    settings,
    settingsStore,
    manifest: { id: "agentic-chat", version: "test" },
    isAnyViewStreaming: () => views.some((view) => view.isStreaming()),
    createAgentService: (handlers: {
      askUser?: AskUserHandler;
      confirmToolCall?: (request: ToolApprovalRequest, signal?: AbortSignal) => Promise<UserApprovalChoice>;
    } = {}) =>
      new AgentService({
        app: fake.app,
        getSettings: () => settings,
        sessionManager: new ObsidianSessionManager(adapter, "sessions", "vault:ui-test", registry),
        confirmToolCall: options.approve ?? handlers.confirmToolCall ?? (async () => ({ approved: true, remember: false })),
        askUser: handlers.askUser,
        streamFn: replay.streamFn,
        loopGuardDisabled: true,
        saveSettings: () => settingsStore.save(),
      }),
  } as unknown as AgenticChatPlugin;

  const leaf = new WorkspaceLeaf(fake.app);
  const view = new ChatView(leaf as never, plugin);
  views.push(view);
  fake.workspace.activeView = view;
  view.load();
  await view.onOpen();
  await settle();

  const root = view.contentEl;
  const internals = view as unknown as {
    handleAgentEvent: (event: AgentEvent) => void;
    service: AgentService;
  };
  const $ = <T extends Element = HTMLElement>(selector: string) => root.ownerDocument.querySelector<T>(selector);
  const $$ = <T extends Element = HTMLElement>(selector: string) =>
    Array.from(root.ownerDocument.querySelectorAll<T>(selector));
  const type = (text: string): HTMLTextAreaElement => {
    const input = root.querySelector<HTMLTextAreaElement>(".agentic-chat-input");
    if (!input) throw new Error("composer input not mounted");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return input;
  };
  const idle = async () => {
    for (let round = 0; round < 50; round += 1) {
      await settle(5);
      if (!internals.service.isStreaming()) break;
    }
    await settle();
  };

  return {
    view,
    app: fake,
    plugin,
    settings,
    adapter,
    calls: () => replay.calls.length,
    root,
    emit: (event) => internals.handleAgentEvent(event as unknown as AgentEvent),
    $,
    $$,
    send: async (text) => {
      type(text).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await settle();
    },
    queue: async (text) => {
      type(text);
      root.querySelector<HTMLButtonElement>(".agentic-chat-send")?.click();
      await settle();
    },
    idle,
    close: async () => {
      await view.onClose();
      view.unload();
    },
  };
}

/** Seed a vault file and return it. */
export async function seedFile(app: FakeApp, path: string, content = `seed: ${path}`): Promise<TFile> {
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (folder && !app.vault.hasFolder(folder)) await app.vault.createFolder(folder);
  return app.vault.create(path, content);
}
