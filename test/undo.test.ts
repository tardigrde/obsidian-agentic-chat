import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { TFile } from "obsidian";
import { applyUndo, captureUndo, describeUndo } from "../src/agent/undo";

/** Tiny in-memory vault backing the undo capture/apply round-trips. */
function makeApp(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const folders = new Set<string>();
  const fileFor = (path: string): TFile | null => {
    if (!files.has(path)) return null;
    const file = new TFile();
    file.path = path;
    return file;
  };
  const app = {
    vault: {
      getAbstractFileByPath: (p: string) => fileFor(p),
      cachedRead: async (f: TFile) => files.get(f.path) ?? "",
      read: async (f: TFile) => files.get(f.path) ?? "",
      modify: async (f: TFile, c: string) => void files.set(f.path, c),
      create: async (p: string, c: string) => {
        files.set(p, c);
        const file = new TFile();
        file.path = p;
        return file;
      },
      createFolder: async (p: string) => void folders.add(p),
      getFolderByPath: (p: string) => (folders.has(p) ? { path: p } : null),
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
  return { app, files };
}

describe("captureUndo + applyUndo", () => {
  it("reverts a write over an existing file", async () => {
    const { app, files } = makeApp({ "n.md": "old" });
    const entry = await captureUndo(app, "write", { path: "n.md", content: "new" });
    expect(entry).toEqual({ kind: "content", path: "n.md", before: "old" });
    files.set("n.md", "new"); // simulate the write running
    await applyUndo(app, entry!);
    expect(files.get("n.md")).toBe("old");
  });

  it("reverts a write that created a new file by removing it", async () => {
    const { app, files } = makeApp();
    const entry = await captureUndo(app, "write", { path: "n.md", content: "hi" });
    expect(entry).toEqual({ kind: "content", path: "n.md", before: null });
    files.set("n.md", "hi"); // simulate create
    await applyUndo(app, entry!);
    expect(files.has("n.md")).toBe(false);
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
    expect(entry).toEqual({ kind: "delete", path: "n.md", before: "body" });
    files.delete("n.md"); // simulate delete
    await applyUndo(app, entry!);
    expect(files.get("n.md")).toBe("body");
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

  it("describes pending undos", () => {
    expect(describeUndo({ kind: "rename", from: "a.md", to: "b.md" })).toBe("rename b.md → a.md");
    expect(describeUndo({ kind: "delete", path: "n.md", before: "x" })).toBe("restore n.md");
    expect(describeUndo({ kind: "content", path: "n.md", before: null })).toBe("remove n.md");
    expect(describeUndo({ kind: "content", path: "n.md", before: "x" })).toBe("revert n.md");
  });
});
