import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { TFile, TFolder } from "obsidian";
import { applyUndo, captureUndo } from "../src/agent/undo";

/** Tiny in-memory vault backing the undo capture/apply round-trips. */
function makeApp(initial: Record<string, string> = {}, initialFolders: string[] = []) {
  const files = new Map<string, string>(Object.entries(initial));
  const folders = new Set<string>(initialFolders);
  const fileFor = (path: string): TFile | null => {
    if (!files.has(path)) return null;
    const file = new TFile();
    file.path = path;
    return file;
  };
  const folderFor = (path: string): TFolder | null => {
    if (!folders.has(path)) return null;
    const folder = new TFolder();
    folder.path = path;
    folder.children = [];
    return folder;
  };
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => fileFor(p) ?? folderFor(p),
      cachedRead: async (f: TFile) => files.get(f.path) ?? "",
      read: async (f: TFile) => files.get(f.path) ?? "",
      modify: async (f: TFile, c: string) => void files.set(f.path, c),
      process: async (f: TFile, fn: (content: string) => string) => {
        const content = fn(files.get(f.path) ?? "");
        files.set(f.path, content);
        return content;
      },
      trash: async (f: TFile) => void files.delete(f.path),
      create: async (p: string, c: string) => {
        files.set(p, c);
        const file = new TFile();
        file.path = p;
        return file;
      },
      createFolder: async (p: string) => void folders.add(p),
      getFolderByPath: (p: string) => (folders.has(p) ? { path: p } : null),
      getConfig: () => false,
      setConfig: () => undefined,
    },
    fileManager: {
      renameFile: async (f: TFile, np: string) => {
        const c = files.get(f.path) ?? "";
        files.delete(f.path);
        files.set(np, c);
      },
      trashFile: async (f: TFile) => void files.delete(f.path),
    },
  } as unknown as App;
  return { app, files, folders };
}

describe("captureUndo + applyUndo", () => {
  it("reverts a write over an existing file", async () => {
    const { app, files } = makeApp({ "n.md": "old" });
    const entry = await captureUndo(app, "write", { path: "n.md", content: "new" });
    expect(entry).toMatchObject({ kind: "content", path: "n.md", before: "old" });
    expect(entry?.kind === "content" && entry.beforeSummary?.length).toBe("old".length);
    files.set("n.md", "new");
    await applyUndo(app, entry!);
    expect(files.get("n.md")).toBe("old");
  });

  it("reverts a write that created a new file by removing it", async () => {
    const { app, files } = makeApp();
    const entry = await captureUndo(app, "write", { path: "n.md", content: "hi" });
    expect(entry).toEqual({ kind: "content", path: "n.md", before: null });
    files.set("n.md", "hi");
    await applyUndo(app, entry!);
    expect(files.has("n.md")).toBe(false);
  });

  it("removes a created file and says so when the system trash leaves it in place", async () => {
    const { app, files } = makeApp();
    const entry = await captureUndo(app, "write", { path: "n.md", content: "hi" });
    files.set("n.md", "hi");
    // Obsidian's system trash can return without moving anything (a Linux
    // desktop with no trash service), and this vault has no .trash folder.
    const calls: string[] = [];
    const target = app as unknown as {
      fileManager: { trashFile: (file: TFile) => Promise<void> };
      vault: { adapter: unknown };
    };
    target.fileManager.trashFile = async () => void calls.push("trashFile");
    target.vault.adapter = {
      exists: async (path: string) => files.has(path),
      trashLocal: async () => {
        calls.push("trashLocal");
        throw new Error("no .trash");
      },
      remove: async (path: string) => {
        calls.push("remove");
        files.delete(path);
      },
    };

    const message = await applyUndo(app, entry!);

    expect(calls).toEqual(["trashFile", "trashLocal", "remove"]);
    expect(files.has("n.md")).toBe(false);
    expect(message).toBe("Removed n.md (it didn't exist before, bypassed trash).");
  });

  it("captures edit only when the file exists", async () => {
    const { app } = makeApp({ "n.md": "x" });
    expect(await captureUndo(app, "edit", { path: "n.md", edits: [] })).toMatchObject({ kind: "content", before: "x" });
    const { app: empty } = makeApp();
    expect(await captureUndo(empty, "edit", { path: "n.md", edits: [] })).toBeNull();
  });

  it("restores a deleted file", async () => {
    const { app, files } = makeApp({ "n.md": "body" });
    const entry = await captureUndo(app, "delete", { path: "n.md" });
    expect(entry).toMatchObject({ kind: "delete", path: "n.md", before: "body" });
    expect(entry?.kind === "delete" && entry.beforeSummary?.length).toBe("body".length);
    files.delete("n.md");
    await applyUndo(app, entry!);
    expect(files.get("n.md")).toBe("body");
  });

  it("restores a deleted empty folder", async () => {
    const { app, folders } = makeApp({}, ["Empty"]);
    const entry = await captureUndo(app, "delete", { path: "Empty" });
    expect(entry).toEqual({ kind: "delete_folder", path: "Empty" });
    folders.delete("Empty");
    await applyUndo(app, entry!);
    expect(folders.has("Empty")).toBe(true);
  });

  it("reverses a rename", async () => {
    const { app, files } = makeApp({ "a.md": "body" });
    const entry = await captureUndo(app, "rename", { path: "a.md", newPath: "b.md" });
    expect(entry).toEqual({ kind: "rename", from: "a.md", to: "b.md" });
    await app.fileManager.renameFile(Object.assign(new TFile(), { path: "a.md" }), "b.md"); // simulate rename
    await applyUndo(app, entry!);
    expect(files.has("a.md")).toBe(true);
    expect(files.has("b.md")).toBe(false);
  });

  it("never throws on capture failure", async () => {
    const broken = { vault: {} } as unknown as App;
    expect(await captureUndo(broken, "write", { path: "n.md", content: "x" })).toBeNull();
  });

});
