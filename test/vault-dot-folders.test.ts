import { describe, expect, it } from "vitest";
import { TFile, TFolder, type App } from "obsidian";
import { createVaultTools } from "../src/tools/vault-tools";
import { unwrapToolOutput } from "../src/tools/tool-output-wrapper";
import { ReadMemo } from "../src/vault/read-memo";

/**
 * Dot-folder staleness harness: the vault tree misses `.agentic-plugins`
 * (created outside the session) while the adapter has it — the exact shape
 * from the failed `gemini-image` skill install. `createFolder` throws like
 * real Obsidian when the path exists on disk but not in the tree.
 */
function makeStaleDotFolderApp() {
  const treeFolders = new Set<string>(["/"]);
  const treeFiles = new Map<string, string>();
  const diskFolders = new Set<string>([
    "/",
    ".agentic-plugins",
    ".agentic-plugins/builtins",
    ".agentic-plugins/builtins/skills",
    ".agentic-plugins/builtins/skills/self-knowledge",
  ]);
  const diskFiles = new Map<string, string>([
    [".agentic-plugins/builtins/plugin.json", '{"name":"builtins"}'],
    [".agentic-plugins/builtins/skills/self-knowledge/SKILL.md", "# Self\n"],
  ]);
  const createdFolders: string[] = [];
  const trashed: string[] = [];

  const topLevel = (prefix: string, key: string): boolean =>
    prefix ? key.startsWith(`${prefix}/`) && !key.slice(prefix.length + 1).includes("/") : !key.includes("/");

  const app = {
    vault: {
      getFolderByPath: (path: string) => {
        const key = path || "/";
        if (!treeFolders.has(key)) return null;
        const folder = new TFolder();
        folder.path = path;
        folder.name = path.split("/").pop() ?? path;
        folder.children = [];
        return folder;
      },
      getFileByPath: (path: string) => {
        const content = treeFiles.get(path);
        if (content === undefined) return null;
        const file = new TFile();
        file.path = path;
        file.name = path.split("/").pop() ?? path;
        file.extension = file.name.includes(".") ? (file.name.split(".").pop() ?? "") : "";
        (file as unknown as { stat: { size: number; mtime: number } }).stat = { size: content.length, mtime: 1 };
        return file;
      },
      getAbstractFileByPath: (path: string) => {
        if (treeFiles.has(path)) return (app.vault as unknown as { getFileByPath(p: string): TFile | null }).getFileByPath(path);
        if (treeFolders.has(path || "/")) {
          const folder = new TFolder();
          folder.path = path;
          return folder;
        }
        return null;
      },
      getRoot: () => {
        const root = new TFolder();
        root.path = "/";
        root.children = [];
        return root;
      },
      getFiles: () => [],
      cachedRead: async (file: TFile) => treeFiles.get(file.path) ?? "",
      process: async (file: TFile, fn: (content: string) => string) => {
        const next = fn(treeFiles.get(file.path) ?? "");
        treeFiles.set(file.path, next);
        diskFiles.set(file.path, next);
        return next;
      },
      create: async (path: string, content: string) => {
        const file = new TFile();
        file.path = path;
        treeFiles.set(path, content);
        diskFiles.set(path, content);
        return file;
      },
      createFolder: async (path: string) => {
        // Real Obsidian throws when the folder exists on disk, even when the
        // tree has not indexed it — the reported install failure.
        if (treeFolders.has(path) || diskFolders.has(path)) {
          throw new Error(`Folder already exists: ${path}`);
        }
        createdFolders.push(path);
        treeFolders.add(path);
        diskFolders.add(path);
        const folder = new TFolder();
        folder.path = path;
        return folder;
      },
      adapter: {
        exists: async (path: string) =>
          diskFolders.has(path) ||
          diskFiles.has(path) ||
          [...diskFolders].some((key) => key.startsWith(`${path}/`)) ||
          [...diskFiles.keys()].some((key) => key === path || key.startsWith(`${path}/`)),
        list: async (path: string) => {
          const onDisk =
            diskFolders.has(path) ||
            [...diskFolders].some((key) => key.startsWith(`${path}/`)) ||
            [...diskFiles.keys()].some((key) => key.startsWith(`${path}/`));
          if (!onDisk) throw new Error(`Folder not found: ${path}`);
          return {
            folders: [...diskFolders].filter((key) => key !== "/" && topLevel(path, key)),
            files: [...diskFiles.keys()].filter((key) => topLevel(path, key)),
          };
        },
        read: async (path: string) => {
          const content = diskFiles.get(path);
          if (content === undefined) throw new Error(`File not found: ${path}`);
          return content;
        },
        trashSystem: async (path: string) => {
          trashed.push(path);
          diskFiles.delete(path);
          for (const key of [...diskFiles.keys()]) {
            if (key === path || key.startsWith(`${path}/`)) diskFiles.delete(key);
          }
          for (const key of [...diskFolders]) {
            if (key === path || key.startsWith(`${path}/`)) diskFolders.delete(key);
          }
          return true;
        },
        trashLocal: async (path: string) => {
          trashed.push(path);
        },
        remove: async (path: string) => {
          if (!diskFiles.delete(path)) throw new Error(`File not found: ${path}`);
        },
        rmdir: async (path: string, recursive: boolean) => {
          const hasChildren =
            [...diskFolders].some((key) => key.startsWith(`${path}/`)) ||
            [...diskFiles.keys()].some((key) => key.startsWith(`${path}/`));
          if (hasChildren && !recursive) throw new Error(`Folder not empty: ${path}`);
          for (const key of [...diskFiles.keys()]) {
            if (key === path || key.startsWith(`${path}/`)) diskFiles.delete(key);
          }
          for (const key of [...diskFolders]) {
            if (key === path || key.startsWith(`${path}/`)) diskFolders.delete(key);
          }
        },
      },
    },
  } as unknown as App;
  return { app, createdFolders, trashed };
}

function toolByName(app: App, name: string) {
  const tool = createVaultTools(app, () => false, new ReadMemo()).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

async function runText(name: string, app: App, params: unknown): Promise<string> {
  const result = await toolByName(app, name).execute("call-1", params as never, undefined);
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return unwrapToolOutput(text);
}

describe("dot-folder stale tree", () => {
  it("write creates nested files under a stale dot-folder without 'Folder already exists'", async () => {
    const { app, createdFolders } = makeStaleDotFolderApp();
    const text = await runText("write", app, {
      path: ".agentic-plugins/gemini-image/plugin.json",
      content: '{"name":"gemini-image"}',
    });
    expect(text).toContain("Wrote");
    // The stale parent is reused from disk, not re-created.
    expect(createdFolders).not.toContain(".agentic-plugins");
    expect(createdFolders).toContain(".agentic-plugins/gemini-image");
  });

  it("ls falls back to the adapter for stale dot-folders", async () => {
    const { app } = makeStaleDotFolderApp();
    const text = await runText("vault_inspect", app, { action: "list", path: ".agentic-plugins" });
    expect(text).toContain(".agentic-plugins/builtins");
  });

  it("ls still reports missing folders as not found", async () => {
    const { app } = makeStaleDotFolderApp();
    await expect(
      runText("vault_inspect", app, { action: "list", path: ".agentic-plugins/nope" }),
    ).rejects.toThrow(/Folder not found/);
  });

  it("read falls back to the adapter for files under stale dot-folders", async () => {
    const { app } = makeStaleDotFolderApp();
    const text = await runText("read", app, { path: ".agentic-plugins/builtins/plugin.json" });
    expect(text).toContain('"name":"builtins"');
  });

  it("read still reports missing files as not found", async () => {
    const { app } = makeStaleDotFolderApp();
    await expect(runText("read", app, { path: ".agentic-plugins/builtins/missing.json" })).rejects.toThrow(
      /File not found/,
    );
  });

  it("delete falls back to the adapter for a stale dot-folder file", async () => {
    const { app, trashed } = makeStaleDotFolderApp();
    const text = await runText("delete", app, { path: ".agentic-plugins/builtins/plugin.json" });
    expect(text).toContain("trash");
    expect(trashed).toContain(".agentic-plugins/builtins/plugin.json");
  });

  it("delete refuses a stale non-empty folder without recursive, then removes it with recursive:true", async () => {
    const { app, trashed } = makeStaleDotFolderApp();
    await expect(runText("delete", app, { path: ".agentic-plugins/builtins" })).rejects.toThrow(
      /Folder not empty.*recursive:true/,
    );
    const text = await runText("delete", app, { path: ".agentic-plugins/builtins", recursive: true });
    expect(text).toContain("trash");
    expect(trashed).toContain(".agentic-plugins/builtins");
  });

  it("delete still reports missing paths as not found", async () => {
    const { app } = makeStaleDotFolderApp();
    await expect(runText("delete", app, { path: ".agentic-plugins/nope" })).rejects.toThrow(
      /File or folder not found/,
    );
  });
});
