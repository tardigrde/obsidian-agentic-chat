import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { AskUserRequest } from "../src/tools/ask-user-tool";
import { ChatView } from "../src/ui/chat-view";
import { writeMemoryRecords } from "../src/memory/management";
import type { MemoryRecord } from "../src/memory/memory";
import { MemoryAdapter } from "./helpers/memory-adapter";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners: Record<string, Array<() => void>> = {};
  disabled = false;
  hidden = false;
  open = false;
  value = "";
  private text = "";
  private parent: FakeElement | null = null;
  private readonly classes = new Set<string>();

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  createDiv(options?: { cls?: string | string[]; text?: string; attr?: Record<string, string> }): FakeElement {
    return this.createChild("div", options);
  }

  createEl(tag: string, options?: { cls?: string | string[]; text?: string; attr?: Record<string, string> }): FakeElement {
    return this.createChild(tag, options);
  }

  addClass(cls: string): void {
    this.classes.add(cls);
  }

  setText(text: string): void {
    this.text = text;
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners[type] = [...(this.listeners[type] ?? []), listener];
  }

  click(): void {
    for (const listener of this.listeners.click ?? []) listener();
  }

  focus(): void {}

  detach(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }

  findByClass(cls: string): FakeElement | undefined {
    if (this.classes.has(cls)) return this;
    for (const child of this.children) {
      const found = child.findByClass(cls);
      if (found) return found;
    }
    return undefined;
  }

  private createChild(
    tag: string,
    options?: { cls?: string | string[]; text?: string; attr?: Record<string, string> },
  ): FakeElement {
    const child = new FakeElement(tag);
    child.parent = this;
    child.text = options?.text ?? "";
    const classes = Array.isArray(options?.cls) ? options.cls : options?.cls ? [options.cls] : [];
    for (const cls of classes) child.classes.add(cls);
    this.children.push(child);
    return child;
  }
}

describe("ChatView ask_user prompt", () => {
  it("removes the temporary inline prompt immediately after the user answers", async () => {
    const messagesEl = new FakeElement("div");
    const fakeView = {
      messagesEl,
      clearEmptyState: () => {},
      scrollToBottom: () => {},
    };
    const renderAskUserPrompt = (ChatView.prototype as unknown as {
      renderAskUserPrompt: (this: typeof fakeView, request: AskUserRequest) => Promise<string>;
    }).renderAskUserPrompt;

    const answer = renderAskUserPrompt.call(fakeView, { question: "Which folder?", choices: [] });
    const prompt = messagesEl.findByClass("agentic-chat-ask-user");
    const textarea = messagesEl.findByClass("agentic-chat-ask-input");
    const submit = messagesEl.findByClass("agentic-chat-ask-submit");

    expect(prompt).toBeDefined();
    expect(textarea).toBeDefined();
    expect(submit).toBeDefined();

    textarea!.value = "Projects";
    submit!.click();

    await expect(answer).resolves.toBe("Projects");
    expect(messagesEl.findByClass("agentic-chat-ask-user")).toBeUndefined();
  });

  it("exports memory JSONL without opening the export as the active file", async () => {
    const memoryPath = ".obsidian/plugins/agentic-chat/memory/memories.jsonl";
    const adapter = new MemoryAdapter();
    const record: MemoryRecord = {
      id: "mem-export",
      kind: "fact",
      scope: "vault",
      text: "Dogfood memory export should save quietly.",
      enabled: true,
      createdAt: "2026-07-01T00:00:00.000Z",
    };
    await writeMemoryRecords(adapter.asDataAdapter(), memoryPath, [record]);

    const openFile = vi.fn();
    const getLeaf = vi.fn(() => ({ openFile }));
    const create = vi.fn(async (path: string, contents: string) => {
      await adapter.asDataAdapter().write(path, contents);
      return { path };
    });
    const renderInfoMessage = vi.fn();
    const fakeView = {
      app: {
        vault: {
          configDir: ".obsidian",
          adapter: adapter.asDataAdapter(),
          create,
        },
        workspace: { getLeaf },
      },
      plugin: { settings: { projects: { activeProjectId: "", items: [] } } },
      service: {
        getMessages: (): AgentMessage[] => [],
        getSessionInfo: () => ({ id: "session-1" }),
      },
      ensureExportFolder: vi.fn(async () => undefined),
      workflowRenderer: (ChatView.prototype as unknown as { workflowRenderer: () => unknown }).workflowRenderer,
      clearEmptyState: vi.fn(),
      renderInfoMessage,
      renderErrorMessage: vi.fn(),
      renderActionList: vi.fn(),
    };
    const createMemoryWorkflow = (ChatView.prototype as unknown as {
      createMemoryWorkflow: (this: typeof fakeView) => { run: (command: string) => Promise<void> };
    }).createMemoryWorkflow;

    const controller = createMemoryWorkflow.call(fakeView);
    await controller.run("export");

    expect(create).toHaveBeenCalledWith(expect.stringMatching(/^Agentic Chat Exports\/Agentic chat memories .*\.jsonl$/), expect.any(String));
    expect(getLeaf).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
    expect(renderInfoMessage).toHaveBeenCalledWith("Memory", [
      ["Exported", expect.stringMatching(/^1 memories to Agentic Chat Exports\/Agentic chat memories .*\.jsonl\.$/)],
    ]);
  });
});
