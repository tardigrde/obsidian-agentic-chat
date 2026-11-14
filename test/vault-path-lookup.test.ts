import { describe, expect, it } from "vitest";
import { TFile, TFolder, type App } from "obsidian";
import { createIgnoreMatcher, type IgnoreMatcher } from "../src/vault/ignore";
import { findVaultEntry, findVaultFile, pathSuggestion } from "../src/vault/path-lookup";
import { getVisibleVaultFile } from "../src/tools/vault/shared";
import { createLsTool } from "../src/tools/vault/read-tools";
import { createRenameTool, createWriteTool } from "../src/tools/vault/write-tools";

/**
 * In-memory vault with the same lookup surface the tools use. Paths are kept
 * byte-exact: two canonically equivalent spellings are two files here, exactly
 * as they are on a case-sensitive disk.
 */
function makeApp(paths: string[]) {
  const files = new Map<string, TFile>();
  const contents = new Map<string, string>();
  const folders = new Map<string, TFolder>();
  const root = new TFolder();
  root.path = "/";
  root.name = "";
  root.children = [];
  folders.set("/", root);

  function ensureFolder(folderPath: string): TFolder {
    const key = folderPath || "/";
    const existing = folders.get(key);
    if (existing) return existing;
    const parentPath = key.includes("/") ? key.slice(0, key.lastIndexOf("/")) : "/";
    const parent = ensureFolder(parentPath);
    const folder = new TFolder();
    folder.path = key;
    folder.name = key.split("/").pop() ?? key;
    folder.parent = parent;
    parent.children.push(folder);
    folders.set(key, folder);
    return folder;
  }

  for (const path of paths) {
    const file = new TFile();
    file.path = path;
    file.name = path.split("/").pop() ?? path;
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
    const parent = ensureFolder(parentPath);
    file.parent = parent;
    parent.children.push(file);
    files.set(path, file);
    contents.set(path, "");
  }
  const renamed: Array<{ from: string; to: string }> = [];
  let alwaysUpdateLinks = false;

  const app = {
    vault: {
      getFileByPath: (path: string) => files.get(path) ?? null,
      getAbstractFileByPath: (path: string) => files.get(path) ?? folders.get(path || "/") ?? null,
      getFolderByPath: (path: string) => folders.get(path || "/") ?? null,
      getFiles: () => [...files.values()],
      getAllLoadedFiles: () => [...folders.values(), ...files.values()],
      getRoot: () => root,
      getConfig: () => alwaysUpdateLinks,
      setConfig: (_key: string, value: unknown) => {
        alwaysUpdateLinks = value === true;
      },
      process: async (file: TFile, fn: (content: string) => string) => {
        const next = fn(contents.get(file.path) ?? "");
        contents.set(file.path, next);
        return next;
      },
      create: async (path: string, content: string) => {
        const file = new TFile();
        file.path = path;
        file.name = path.split("/").pop() ?? path;
        files.set(path, file);
        contents.set(path, content);
        return file;
      },
      adapter: {
        list: async (path: string) => {
          if (!folders.has(path)) throw new Error(`ENOENT: ${path}`);
          return { folders: [], files: [] };
        },
      },
    },
    fileManager: {
      renameFile: async (file: TFile, newPath: string) => {
        renamed.push({ from: file.path, to: newPath });
        files.delete(file.path);
        file.path = newPath;
        files.set(newPath, file);
      },
    },
  } as unknown as App;

  return { app, renamed, contents };
}

const CAFE_NFC = "Notes/Café.md";
const CAFE_NFD = CAFE_NFC.normalize("NFD");
// The real session's near miss: the vault stores "dani-legenbucsu", the model
// asked for "dani-legendsbúcsú" (an extra "ds" and an accented "ú").
const NEAR_MISS = "000 Inbox/dani-legendsbúcsú/Meeting.md";
const REAL_PATH = "000 Inbox/dani-legenbucsu/Meeting.md";
// Four spellings share this NFC form: é+dot-below, e+dot-below+acute,
// e+acute+dot-below, and ẹ+acute. Store two, ask for a third.
const AMBIGUOUS_REQUESTED = "Notes/\u00e9\u0323.md";
const AMBIGUOUS_STORED_A = "Notes/e\u0323\u0301.md";
const AMBIGUOUS_STORED_B = "Notes/\u1eb9\u0301.md";

describe("vault path lookup", function () {
  it("resolves an NFD lookup to the single NFC file", async function () {
    expect(CAFE_NFD).not.toBe(CAFE_NFC);
    const { app, renamed } = makeApp([CAFE_NFC]);
    const tool = createRenameTool(app, () => false);

    await tool.execute("rename-nfd", { path: CAFE_NFD, newPath: "Notes/Moved.md" });

    expect(renamed).toEqual([{ from: CAFE_NFC, to: "Notes/Moved.md" }]);
  });

  it("does not pick one when two spellings normalize to the same path", async function () {
    const requested = AMBIGUOUS_REQUESTED;
    const storedA = AMBIGUOUS_STORED_A;
    const storedB = AMBIGUOUS_STORED_B;
    expect(new Set([requested, storedA, storedB]).size).toBe(3);
    expect(requested.normalize("NFC")).toBe(storedB);
    expect(storedA.normalize("NFC")).toBe(storedB);

    const { app, renamed } = makeApp([storedA, storedB]);
    const tool = createRenameTool(app, () => false);

    await expect(tool.execute("rename-ambiguous", { path: requested, newPath: "Notes/Moved.md" })).rejects.toThrow(
      `File not found: ${requested}`,
    );
    expect(renamed).toEqual([]);
    expect(findVaultFile(app, requested)).toBeUndefined();
  });

  it("suggests the real path for a near-miss spelling", async function () {
    const { app } = makeApp([REAL_PATH]);
    const tool = createRenameTool(app, () => false);

    await expect(tool.execute("rename-near-miss", { path: NEAR_MISS, newPath: "Renamed.md" })).rejects.toThrow(
      `File not found: ${NEAR_MISS}\nDid you mean "${REAL_PATH}"?`,
    );
  });

  it("never suggests an ignored near match", async function () {
    const { app } = makeApp([REAL_PATH]);
    const isIgnored: IgnoreMatcher = createIgnoreMatcher(["000 Inbox/dani-legenbucsu"]);

    expect(() => getVisibleVaultFile(app, isIgnored, NEAR_MISS)).toThrow(`File not found: ${NEAR_MISS}`);
  });

  it("suggests the real folder for a near-miss ls target", async function () {
    const { app } = makeApp([REAL_PATH]);
    const tool = createLsTool(app, () => false);

    await expect(tool.execute("ls-near-miss", { path: "000 Inbox/dani-legendsbúcsú" })).rejects.toThrow(
      'Folder not found: 000 Inbox/dani-legendsbúcsú\nDid you mean "000 Inbox/dani-legenbucsu"?',
    );
  });

  it("never suggests an ignored near-match folder", async function () {
    const { app } = makeApp([REAL_PATH]);
    const isIgnored: IgnoreMatcher = createIgnoreMatcher(["000 Inbox/dani-legenbucsu"]);
    const tool = createLsTool(app, isIgnored);

    await expect(tool.execute("ls-ignored", { path: "000 Inbox/dani-legendsbúcsú" })).rejects.toThrow(
      "Folder not found: 000 Inbox/dani-legendsbúcsú",
    );
  });

  it("finds an entry by NFC when the lookup is NFD", function () {
    const folderNfc = "Notes/Café";
    const { app } = makeApp([CAFE_NFC, `${folderNfc}/A.md`]);

    expect(findVaultFile(app, CAFE_NFD)?.path).toBe(CAFE_NFC);
    expect(findVaultEntry(app, folderNfc.normalize("NFD"))?.path).toBe(folderNfc);
  });

  it("suggests the one clear near miss and nothing else", function () {
    const { app } = makeApp([REAL_PATH]);

    expect(pathSuggestion(app, NEAR_MISS, () => false)).toBe(REAL_PATH);
    expect(pathSuggestion(app, "Completely/Unrelated.md", () => false)).toBeUndefined();
  });

  it("never returns an ignored path as the suggestion", function () {
    const { app } = makeApp([REAL_PATH]);
    const isIgnored: IgnoreMatcher = createIgnoreMatcher(["000 Inbox/dani-legenbucsu"]);

    expect(pathSuggestion(app, NEAR_MISS, isIgnored)).toBeUndefined();
  });

  it("writes over an NFC file reached through an NFD path instead of duplicating it", async function () {
    const { app, contents } = makeApp([CAFE_NFC]);
    const tool = createWriteTool(app, () => false);

    await tool.execute("write-nfd", { path: CAFE_NFD, content: "updated" });

    expect(contents.get(CAFE_NFC)).toBe("updated");
    expect(contents.size).toBe(1);
  });

  it("rejects a rename destination that is already loaded under a different normalization", async function () {
    const { app, renamed } = makeApp([CAFE_NFC, "Notes/Other.md"]);
    const tool = createRenameTool(app, () => false);

    await expect(tool.execute("rename-collision", { path: "Notes/Other.md", newPath: CAFE_NFD })).rejects.toThrow(
      `Something already exists at ${CAFE_NFD}.`,
    );
    expect(renamed).toEqual([]);
  });
});
