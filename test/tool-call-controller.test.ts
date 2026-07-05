import { describe, expect, it } from "vitest";
import { TFile, TFolder, type App } from "obsidian";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ApprovalAuditInput, CheckpointAuditInput } from "../src/agent/action-audit-log";
import type { FileCheckpoint } from "../src/agent/file-checkpoints";
import { AgentToolCallController, type ToolApprovalRequest } from "../src/agent/tool-call-controller";
import type { AgentProfile } from "../src/agent/subagents";
import { DEFAULT_SETTINGS, type AgenticChatSettings } from "../src/settings";
import { createMcpServerSettings } from "../src/mcp/settings";
import { EXTERNAL_INSPECT_TOOL_NAME } from "../src/tools/external-workspace";
import { FakeVault } from "./helpers/fake-vault";

function makeController(
  options: {
    settings?: Partial<AgenticChatSettings>;
    confirmToolCall?: (request: ToolApprovalRequest) => Promise<boolean>;
    tools?: AgentTool[];
    profiles?: AgentProfile[];
    app?: App;
    recordApproval?: (input: ApprovalAuditInput) => Promise<void> | void;
    recordCheckpoint?: (input: CheckpointAuditInput) => Promise<void> | void;
    recordFileCheckpoint?: (checkpoint: FileCheckpoint) => Promise<void> | void;
  } = {},
): { controller: AgentToolCallController; requests: ToolApprovalRequest[]; undoNotifications: { count: number } } {
  const settings: AgenticChatSettings = {
    ...DEFAULT_SETTINGS,
    openrouterApiKey: "test-key",
    ...options.settings,
    approval: { ...DEFAULT_SETTINGS.approval, ...(options.settings?.approval ?? {}) },
  };
  const requests: ToolApprovalRequest[] = [];
  const undoNotifications = { count: 0 };
  const controller = new AgentToolCallController({
    app: options.app ?? fakeApp().app,
    getSettings: () => settings,
    confirmToolCall: async (request) => {
      requests.push(request);
      return options.confirmToolCall ? options.confirmToolCall(request) : true;
    },
    getTools: () => options.tools ?? [{ name: "write", label: "Write file" } as AgentTool],
    getProfiles: () => options.profiles ?? [],
    onUndoApplied: () => {
      undoNotifications.count += 1;
    },
    recordApproval: options.recordApproval,
    recordCheckpoint: options.recordCheckpoint,
    recordFileCheckpoint: options.recordFileCheckpoint,
  });
  return { controller, requests, undoNotifications };
}

function fakeApp(): { app: App; vault: FakeVault } {
  const vault = new FakeVault() as FakeVault & {
    getFolderByPath: (path: string) => TFolder | null;
  };
  vault.getFolderByPath = (path) => {
    const entry = vault.getAbstractFileByPath(path);
    return entry instanceof TFolder ? entry : null;
  };
  return {
    app: {
      vault,
      fileManager: {
        trashFile: async (file: TFile) => vault.trash(file),
      },
    } as unknown as App,
    vault,
  };
}

describe("AgentToolCallController", () => {
  it("prompts ask-policy tool calls with the registered tool label", async () => {
    const { controller, requests } = makeController({
      settings: { mode: "safe", approval: { mutating: "ask", perTool: {}, workingDirs: [] } },
      confirmToolCall: async () => false,
    });

    const decision = await controller.beforeToolCall({
      toolCall: { id: "call-1", name: "write" },
      args: { path: "Notes/a.md", content: "hi" },
    });

    expect(decision).toEqual({ block: true, reason: "The user declined this action." });
    expect(requests).toEqual([{ toolName: "write", label: "Write file", args: { path: "Notes/a.md", content: "hi" } }]);
    expect(controller.canUndo()).toBe(false);
  });

  it("prompts MCP tool calls through the server egress policy", async () => {
    const tool = { name: "mcp__docs__resolve_library_id", label: "Docs MCP: Resolve library" } as AgentTool;
    const { controller, requests } = makeController({
      settings: {
        mcp: {
          enabled: true,
          proxyUrl: "",
          noProxy: "localhost,127.0.0.1,::1",
          servers: [
            {
              ...createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "https://mcp.example.com/mcp" }),
              approval: "ask",
            },
          ],
        },
      },
      tools: [tool],
      confirmToolCall: async () => false,
    });

    const args = { libraryName: "obsidian" };
    const decision = await controller.beforeToolCall({
      toolCall: { id: "call-1", name: tool.name },
      args,
    });

    expect(decision).toEqual({ block: true, reason: "The user declined this MCP tool call." });
    expect(requests).toEqual([{ toolName: tool.name, label: tool.label, args }]);
  });

  it("prompts external inspections by default even though the tool is read-only", async () => {
    const tool = { name: EXTERNAL_INSPECT_TOOL_NAME, label: "Inspect external root" } as AgentTool;
    const { controller, requests } = makeController({
      settings: {
        external: {
          ...DEFAULT_SETTINGS.external,
          enabled: true,
          rootPath: "/workspace/code",
          approval: "ask",
        },
      },
      tools: [tool],
      confirmToolCall: async () => false,
    });

    const args = { action: "search", query: "Service" };
    const decision = await controller.beforeToolCall({
      toolCall: { id: "call-1", name: EXTERNAL_INSPECT_TOOL_NAME },
      args,
    });

    expect(decision).toEqual({ block: true, reason: "The user declined this external workspace inspection." });
    expect(requests).toEqual([{ toolName: EXTERNAL_INSPECT_TOOL_NAME, label: tool.label, args }]);
  });

  it("auto-approves external inspections only when the external setting allows it", async () => {
    const { controller, requests } = makeController({
      settings: {
        external: {
          ...DEFAULT_SETTINGS.external,
          enabled: true,
          rootPath: "/workspace/code",
          approval: "allow",
        },
      },
    });

    await expect(
      controller.beforeToolCall({
        toolCall: { id: "call-1", name: EXTERNAL_INSPECT_TOOL_NAME },
        args: { action: "list" },
      }),
    ).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });

  it("auto-denies external inspections when the external setting denies it", async () => {
    const approvals: ApprovalAuditInput[] = [];
    const { controller, requests } = makeController({
      settings: {
        external: {
          ...DEFAULT_SETTINGS.external,
          enabled: true,
          rootPath: "/workspace/code",
          approval: "deny",
        },
      },
      recordApproval: (input) => {
        approvals.push(input);
      },
    });

    await expect(
      controller.beforeToolCall({
        toolCall: { id: "call-1", name: EXTERNAL_INSPECT_TOOL_NAME },
        args: { action: "list" },
      }),
    ).resolves.toEqual({
      block: true,
      reason: "External workspace inspection is disabled by your external root approval settings.",
    });
    expect(requests).toEqual([]);
    expect(approvals).toMatchObject([
      {
        decision: "denied",
        toolCallId: "call-1",
        toolName: EXTERNAL_INSPECT_TOOL_NAME,
      },
    ]);
  });

  it("honors MCP deny policy and per-tool allow overrides", async () => {
    const toolName = "mcp__docs__resolve_library_id";
    const baseMcp = {
      enabled: true,
      proxyUrl: "",
      noProxy: "localhost,127.0.0.1,::1",
      servers: [
        {
          ...createMcpServerSettings({ id: "docs", name: "Docs MCP", url: "https://mcp.example.com/mcp" }),
          approval: "deny" as const,
        },
      ],
    };
    const denied = makeController({ settings: { mcp: baseMcp } });

    await expect(
      denied.controller.beforeToolCall({ toolCall: { id: "call-1", name: toolName }, args: {} }),
    ).resolves.toEqual({
      block: true,
      reason: `The "${toolName}" MCP tool is disabled by your MCP approval settings.`,
    });

    const allowed = makeController({
      settings: {
        mcp: baseMcp,
        approval: { mutating: "ask", perTool: { [toolName]: "allow" }, workingDirs: [] },
      },
    });
    await expect(
      allowed.controller.beforeToolCall({ toolCall: { id: "call-1", name: toolName }, args: {} }),
    ).resolves.toBeUndefined();
  });

  it("auto-approves read-only subagent dispatches when a working set is configured", async () => {
    const { controller, requests } = makeController({
      settings: { mode: "safe", approval: { mutating: "ask", perTool: {}, workingDirs: ["Notes"] } },
      profiles: [
        {
          name: "researcher",
          description: "Research",
          systemPrompt: "Research.",
          toolAllowlist: ["read", "grep", "find"],
        },
      ],
      confirmToolCall: async () => false,
    });

    const decision = await controller.beforeToolCall({
      toolCall: { id: "call-1", name: "subagent" },
      args: { agent: "researcher", task: "look around" },
    });

    expect(decision).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it("records undo only after a captured mutating call succeeds", async () => {
    const { app, vault } = fakeApp();
    await vault.createFolder("Notes");
    const file = await vault.create("Notes/a.md", "before");
    const { controller, undoNotifications } = makeController({
      app,
      settings: { mode: "yolo", approval: { mutating: "allow", perTool: {}, workingDirs: [] } },
    });

    const decision = await controller.beforeToolCall({
      toolCall: { id: "call-1", name: "write" },
      args: { path: "Notes/a.md", content: "after" },
    });
    expect(decision).toBeUndefined();
    await vault.modify(file, "after");
    expect(controller.canUndo()).toBe(false);

    await controller.afterToolCall({ toolCall: { id: "call-1" }, isError: false });
    expect(controller.canUndo()).toBe(true);

    expect(await controller.undoLastChange()).toBe("Reverted Notes/a.md.");
    expect(vault.contentOf("Notes/a.md")).toBe("before");
    expect(undoNotifications.count).toBe(1);
  });

  it("audits approval decisions and pre-change checkpoints", async () => {
    const { app, vault } = fakeApp();
    await vault.createFolder("Notes");
    await vault.create("Notes/a.md", "before");
    const approvals: ApprovalAuditInput[] = [];
    const checkpoints: CheckpointAuditInput[] = [];
    const fileCheckpoints: FileCheckpoint[] = [];
    const { controller } = makeController({
      app,
      settings: { mode: "safe", approval: { mutating: "ask", perTool: {}, workingDirs: [] } },
      confirmToolCall: async () => true,
      recordApproval: (input) => {
        approvals.push(input);
      },
      recordCheckpoint: (input) => {
        checkpoints.push(input);
      },
      recordFileCheckpoint: (checkpoint) => {
        fileCheckpoints.push(checkpoint);
      },
    });

    const decision = await controller.beforeToolCall({
      toolCall: { id: "call-1", name: "write" },
      args: { path: "Notes/a.md", content: "after", apiKey: "secret" },
    });

    expect(decision).toBeUndefined();
    expect(approvals.map((approval) => approval.decision)).toEqual(["requested", "approved"]);
    expect(approvals.map((approval) => approval.toolCallId)).toEqual(["call-1", "call-1"]);
    expect(checkpoints).toEqual([
      {
        toolCallId: "call-1",
        toolName: "write",
        undo: { kind: "content", path: "Notes/a.md", before: "before" },
      },
    ]);
    expect(fileCheckpoints).toEqual([
      expect.objectContaining({
        id: "checkpoint-call-1",
        toolCallId: "call-1",
        toolName: "write",
        entries: [{ kind: "content", path: "Notes/a.md", before: "before" }],
      }),
    ]);
  });

  it("undoes successful mutations newest-first", async () => {
    const { app, vault } = fakeApp();
    await vault.createFolder("Notes");
    const fileA = await vault.create("Notes/a.md", "before a");
    const fileB = await vault.create("Notes/b.md", "before b");
    const { controller, undoNotifications } = makeController({
      app,
      settings: { mode: "yolo", approval: { mutating: "allow", perTool: {}, workingDirs: [] } },
    });

    await controller.beforeToolCall({
      toolCall: { id: "call-a", name: "write" },
      args: { path: "Notes/a.md", content: "after a" },
    });
    await vault.modify(fileA, "after a");
    await controller.afterToolCall({ toolCall: { id: "call-a" }, isError: false });

    await controller.beforeToolCall({
      toolCall: { id: "call-b", name: "write" },
      args: { path: "Notes/b.md", content: "after b" },
    });
    await vault.modify(fileB, "after b");
    await controller.afterToolCall({ toolCall: { id: "call-b" }, isError: false });

    expect(await controller.undoLastChange()).toBe("Reverted Notes/b.md.");
    expect(vault.contentOf("Notes/a.md")).toBe("after a");
    expect(vault.contentOf("Notes/b.md")).toBe("before b");

    expect(await controller.undoLastChange()).toBe("Reverted Notes/a.md.");
    expect(vault.contentOf("Notes/a.md")).toBe("before a");
    expect(controller.canUndo()).toBe(false);
    expect(undoNotifications.count).toBe(2);
  });

  it("keeps the undo entry available when applying undo fails", async () => {
    const { app, vault } = fakeApp();
    await vault.createFolder("Notes");
    const { controller } = makeController({
      app,
      settings: { mode: "yolo", approval: { mutating: "allow", perTool: {}, workingDirs: [] } },
    });

    await controller.beforeToolCall({
      toolCall: { id: "call-1", name: "write" },
      args: { path: "Notes/new.md", content: "created" },
    });
    await vault.create("Notes/new.md", "created");
    await controller.afterToolCall({ toolCall: { id: "call-1" }, isError: false });

    const fileManager = app.fileManager as { trashFile: (file: TFile) => Promise<void> };
    const originalTrashFile = fileManager.trashFile;
    fileManager.trashFile = async () => {
      throw new Error("trash unavailable");
    };

    expect(await controller.undoLastChange()).toBe("Could not undo: trash unavailable");
    expect(controller.canUndo()).toBe(true);
    expect(vault.contentOf("Notes/new.md")).toBe("created");

    fileManager.trashFile = originalTrashFile;
    expect(await controller.undoLastChange()).toBe("Removed Notes/new.md (it didn't exist before).");
    expect(controller.canUndo()).toBe(false);
    expect(vault.getAbstractFileByPath("Notes/new.md")).toBeNull();
  });

  it("drops captured undo when the tool call fails", async () => {
    const { app, vault } = fakeApp();
    await vault.createFolder("Notes");
    await vault.create("Notes/a.md", "before");
    const { controller } = makeController({
      app,
      settings: { mode: "yolo", approval: { mutating: "allow", perTool: {}, workingDirs: [] } },
    });

    await controller.beforeToolCall({
      toolCall: { id: "call-1", name: "write" },
      args: { path: "Notes/a.md", content: "after" },
    });
    await controller.afterToolCall({ toolCall: { id: "call-1" }, isError: true });

    expect(controller.canUndo()).toBe(false);
    expect(await controller.undoLastChange()).toBe("Nothing to undo.");
  });
});
