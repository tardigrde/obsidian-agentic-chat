import { describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/ui/chat-view";
import { MemoryAdapter } from "./helpers/memory-adapter";

type ChatViewSemanticHarness = {
  runSemanticIndex: (arg: string) => Promise<void>;
  semanticIndexWorkflow?: unknown;
};

describe("ChatView semantic index workflow", () => {
  it("reuses one semantic-index controller across commands", async () => {
    const adapter = new MemoryAdapter();
    const renderInfoMessage = vi.fn();
    const fakeView = Object.assign(Object.create(ChatView.prototype), {
      app: {
        vault: {
          configDir: ".obsidian",
          adapter: adapter.asDataAdapter(),
        },
      },
      plugin: {
        manifest: { dir: ".obsidian/plugins/agentic-chat", id: "agentic-chat" },
        settings: {
          projects: { activeProjectId: "", items: [] },
          embeddings: {},
          network: {},
        },
      },
      activeNotePath: null,
      clearEmptyState: vi.fn(),
      renderInfoMessage,
      renderErrorMessage: vi.fn(),
      renderActionList: vi.fn(),
    }) as ChatViewSemanticHarness;

    await fakeView.runSemanticIndex("cancel");
    const firstController = fakeView.semanticIndexWorkflow;
    await fakeView.runSemanticIndex("cancel");

    expect(firstController).toBeDefined();
    expect(fakeView.semanticIndexWorkflow).toBe(firstController);
    expect(renderInfoMessage).toHaveBeenCalledWith("Semantic index", [
      ["Cancel", "No semantic indexing run is active."],
    ]);
  });
});
