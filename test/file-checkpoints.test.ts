import { describe, expect, it } from "vitest";
import { TFile, TFolder, type App } from "obsidian";
import { captureUndo } from "../src/agent/undo";
import {
  createFileCheckpoint,
  createFileCheckpointFromUndo,
  fileCheckpointTouchedPaths,
  restoreFileCheckpoint,
} from "../src/agent/file-checkpoints";
import { ObsidianSessionManager } from "../src/session/session-manager";
import { parseSessionEntries } from "../src/session/jsonl";
import { MemoryAdapter } from "./helpers/memory-adapter";

const DEFAULTS = { provider: "openrouter", modelId: "x/y", thinkingLevel: "off" as const };
const FIXED_NOW = Date.UTC(2026, 5, 26, 10, 0, 0);

function makeCheckpointApp(
  initial: Record<string, string> = {},
  initialFolders: string[] = [],
): { app: App; files: Map<string, string>; folders: Set<string> } {
  const files = new Map<string, string>(Object.entries(initial));
  const folders = new Set<string>(["", ...initialFolders]);
  for (const path of files.keys()) ensureParentFolders(path);

  function ensureParentFolders(path: string): void {
    const segments = path.split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      folders.add(current);
    }
  }

  function fileFor(path: string): TFile | null {
    if (!files.has(path)) return null;
    const file = new TFile();
    file.path = path;
    file.name = path.split("/").pop() ?? path;
    return file;
  }

  function folderFor(path: string): TFolder | null {
    if (!folders.has(path)) return null;
    const folder = new TFolder();
    folder.path = path;
    folder.name = path.split("/").pop() ?? path;
    folder.children = [];
    return folder;
  }

  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => fileFor(path) ?? folderFor(path),
      cachedRead: async (file: TFile) => files.get(file.path) ?? "",
      process: async (file: TFile, fn: (content: string) => string) => {
        const next = fn(files.get(file.path) ?? "");
        files.set(file.path, next);
        return next;
      },
      create: async (path: string, content: string) => {
        ensureParentFolders(path);
        files.set(path, content);
        return fileFor(path);
      },
      createFolder: async (path: string) => void folders.add(path),
      getFolderByPath: (path: string) => (folders.has(path) ? { path } : null),
    },
    fileManager: {
      renameFile: async (file: TFile, newPath: string) => {
        const content = files.get(file.path);
        if (content === undefined) throw new Error(`${file.path} no longer exists.`);
        ensureParentFolders(newPath);
        files.delete(file.path);
        files.set(newPath, content);
      },
      trashFile: async (file: TFile) => void files.delete(file.path),
    },
  } as unknown as App;

  return { app, files, folders };
}

describe("file checkpoints", () => {
  it("restores an overwritten file from a content checkpoint", async () => {
    const { app, files } = makeCheckpointApp({ "Notes/A.md": "before" });
    const checkpoint = createFileCheckpointFromUndo({
      toolCallId: "call-1",
      toolName: "write",
      undo: { kind: "content", path: "Notes/A.md", before: "before" },
      now: () => FIXED_NOW,
    });
    files.set("Notes/A.md", "after");

    const result = await restoreFileCheckpoint(app, checkpoint);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("Reverted Notes/A.md.");
    expect(files.get("Notes/A.md")).toBe("before");
  });

  it("removes a file created by a write checkpoint", async () => {
    const { app, files } = makeCheckpointApp();
    const checkpoint = createFileCheckpointFromUndo({
      toolCallId: "call-new",
      toolName: "write",
      undo: { kind: "content", path: "Notes/New.md", before: null },
      now: () => FIXED_NOW,
    });
    files.set("Notes/New.md", "created");

    const result = await restoreFileCheckpoint(app, checkpoint);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("Removed Notes/New.md (it didn't exist before).");
    expect(files.has("Notes/New.md")).toBe(false);
  });

  it("restores multi-file checkpoints newest entry first", async () => {
    const { app, files } = makeCheckpointApp({ "A.md": "old a", "B.md": "old b" });
    const checkpoint = createFileCheckpoint({
      toolCallId: "call-many",
      toolName: "batch",
      entries: [
        { kind: "content", path: "A.md", before: "old a" },
        { kind: "content", path: "B.md", before: "old b" },
      ],
      now: () => FIXED_NOW,
    });
    files.set("A.md", "new a");
    files.set("B.md", "new b");

    const result = await restoreFileCheckpoint(app, checkpoint);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("Restored 2 checkpoint changes.");
    expect(files.get("A.md")).toBe("old a");
    expect(files.get("B.md")).toBe("old b");
  });

  it("rewinds rename and delete checkpoints", async () => {
    const { app, files, folders } = makeCheckpointApp({ "Old.md": "body", "Deleted.md": "gone" }, ["Empty"]);
    await app.fileManager.renameFile(Object.assign(new TFile(), { path: "Old.md" }), "New.md");
    files.delete("Deleted.md");
    folders.delete("Empty");
    const checkpoint = createFileCheckpoint({
      toolCallId: "call-move-delete",
      toolName: "batch",
      entries: [
        { kind: "rename", from: "Old.md", to: "New.md" },
        { kind: "delete", path: "Deleted.md", before: "gone" },
        { kind: "delete_folder", path: "Empty" },
      ],
      now: () => FIXED_NOW,
    });

    const result = await restoreFileCheckpoint(app, checkpoint);

    expect(result.ok).toBe(true);
    expect(files.get("Old.md")).toBe("body");
    expect(files.has("New.md")).toBe(false);
    expect(files.get("Deleted.md")).toBe("gone");
    expect(folders.has("Empty")).toBe(true);
  });

  it("captures frontmatter updates as restorable content checkpoints", async () => {
    const before = "---\nstatus: draft\n---\nBody";
    const after = "---\nstatus: done\n---\nBody";
    const { app, files } = makeCheckpointApp({ "Note.md": before });
    const undo = await captureUndo(app, "set_properties", { path: "Note.md", properties: { status: "done" } });
    if (!undo) throw new Error("expected set_properties to capture undo");
    files.set("Note.md", after);

    const result = await restoreFileCheckpoint(
      app,
      createFileCheckpointFromUndo({ toolCallId: "call-fm", toolName: "set_properties", undo }),
    );

    expect(result.ok).toBe(true);
    expect(files.get("Note.md")).toBe(before);
  });

  it("persists checkpoints in session JSONL for reload/export", async () => {
    const adapter = new MemoryAdapter();
    const manager = new ObsidianSessionManager(adapter.asDataAdapter(), "sessions", "vault:test");
    const info = await manager.createSession(DEFAULTS);
    const checkpoint = createFileCheckpointFromUndo({
      toolCallId: "call-jsonl",
      toolName: "write",
      undo: { kind: "content", path: "Notes/A.md", before: "old" },
      now: () => FIXED_NOW,
    });

    await manager.appendFileCheckpoint(checkpoint);

    const entries = parseSessionEntries(adapter.files.get(info.path) ?? "");
    expect(entries.filter((entry) => entry.type === "file_checkpoint")).toEqual([
      expect.objectContaining({ type: "file_checkpoint", checkpoint }),
    ]);
  });

  it("reports partial restore failures without hiding successful restores", async () => {
    const { app, files } = makeCheckpointApp({ "B.md": "old b" });
    files.set("B.md", "new b");
    const checkpoint = createFileCheckpoint({
      toolCallId: "call-partial",
      toolName: "batch",
      entries: [
        { kind: "rename", from: "Old.md", to: "Missing.md" },
        { kind: "content", path: "B.md", before: "old b" },
      ],
      now: () => FIXED_NOW,
    });

    const result = await restoreFileCheckpoint(app, checkpoint);

    expect(result.ok).toBe(false);
    expect(result.restored).toEqual(["Reverted B.md."]);
    expect(result.failed).toEqual([expect.objectContaining({ error: "Missing.md no longer exists." })]);
    expect(result.summary).toContain("Partially restored 1 checkpoint changes");
    expect(files.get("B.md")).toBe("old b");
  });

  it("reports touched paths for checkpoint filtering and display", () => {
    const checkpoint = createFileCheckpoint({
      toolCallId: "call-paths",
      toolName: "batch",
      entries: [
        { kind: "rename", from: "A.md", to: "B.md" },
        { kind: "delete", path: "C.md", before: "c" },
        { kind: "delete_folder", path: "Empty" },
      ],
      now: () => FIXED_NOW,
    });

    expect(fileCheckpointTouchedPaths(checkpoint)).toEqual(["A.md", "B.md", "C.md", "Empty"]);
  });
});
