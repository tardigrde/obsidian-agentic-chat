import { describe, expect, it } from "vitest";
import { TFolder, type App } from "obsidian";
import { MemoryAdapter } from "./helpers/memory-adapter";
import {
  ensureAdapterFolder,
  ensureVaultFolder,
  renameOver,
  writeFileAtomically,
} from "../src/vault/storage";

/** A write that lands half its bytes, then fails: a crash mid-write. */
function tearNextWrite(adapter: MemoryAdapter, path: string): void {
  const original = adapter.write.bind(adapter);
  let torn = false;
  adapter.write = async (target, data) => {
    if (!torn && target === path) {
      torn = true;
      adapter.files.set(target, data.slice(0, Math.floor(data.length / 2)));
      throw new Error("disk full");
    }
    return original(target, data);
  };
}

/** A rename that refuses to overwrite an existing target, like some adapters. */
function refuseOverwrite(adapter: MemoryAdapter): void {
  const original = adapter.rename.bind(adapter);
  adapter.rename = async (from, to) => {
    if (adapter.files.has(to)) throw new Error("EEXIST");
    return original(from, to);
  };
}

describe("writeFileAtomically", () => {
  it("keeps the old file when the write tears", async () => {
    const adapter = new MemoryAdapter();
    adapter.files.set("state/data.json", "old");
    tearNextWrite(adapter, "state/data.json.tmp");

    await expect(writeFileAtomically(adapter.asDataAdapter(), "state/data.json", "new content")).rejects.toThrow(
      "disk full",
    );

    expect(adapter.files.get("state/data.json")).toBe("old");
    expect(adapter.files.has("state/data.json.tmp")).toBe(false);
  });

  it("replaces through remove + rename when the adapter refuses to overwrite", async () => {
    const adapter = new MemoryAdapter();
    adapter.files.set("data.json", "old");
    refuseOverwrite(adapter);

    await writeFileAtomically(adapter.asDataAdapter(), "data.json", "new");

    expect(adapter.files.get("data.json")).toBe("new");
    expect(adapter.files.has("data.json.tmp")).toBe(false);
  });
});

describe("renameOver", () => {
  it("rethrows when the staged file is missing instead of removing the target", async () => {
    const adapter = new MemoryAdapter();
    adapter.files.set("target", "keep");

    await expect(renameOver(adapter.asDataAdapter(), "missing.tmp", "target")).rejects.toThrow("Not found");
    expect(adapter.files.get("target")).toBe("keep");
  });

  it("hands an overwrite refusal to the caller's strategy", async () => {
    const adapter = new MemoryAdapter();
    adapter.files.set("a.tmp", "new");
    adapter.files.set("a", "old");
    refuseOverwrite(adapter);
    const calls: string[] = [];

    await renameOver(adapter.asDataAdapter(), "a.tmp", "a", async () => {
      calls.push("replace");
    });

    expect(calls).toEqual(["replace"]);
    expect(adapter.files.get("a")).toBe("old");
  });
});

describe("ensureAdapterFolder", () => {
  it("creates each missing segment once and skips empty segments", async () => {
    const adapter = new MemoryAdapter();
    const made: string[] = [];
    const original = adapter.mkdir.bind(adapter);
    adapter.mkdir = async (path) => {
      made.push(path);
      return original(path);
    };

    await ensureAdapterFolder(adapter.asDataAdapter(), "/a//b/c/");
    await ensureAdapterFolder(adapter.asDataAdapter(), "a/b/c");

    expect(made).toEqual(["a", "a/b", "a/b/c"]);
  });
});

describe("ensureVaultFolder", () => {
  function makeApp(options: { tree?: string[]; disk?: string[]; files?: string[]; raceOn?: string }) {
    const tree = new Set(options.tree ?? []);
    const disk = new Set([...(options.disk ?? []), ...tree]);
    const files = new Set(options.files ?? []);
    const created: string[] = [];
    const app = {
      vault: {
        getAbstractFileByPath: (path: string) => {
          if (!tree.has(path)) return null;
          const folder = new TFolder();
          folder.path = path;
          return folder;
        },
        createFolder: async (path: string) => {
          if (path === options.raceOn) {
            disk.add(path);
            throw new Error("Folder already exists.");
          }
          if (disk.has(path) || files.has(path)) throw new Error("Folder already exists.");
          created.push(path);
          tree.add(path);
          disk.add(path);
        },
        adapter: {
          list: async (path: string) => {
            if (!disk.has(path)) throw new Error("ENOENT");
            return { files: [], folders: [] };
          },
        },
      },
    } as unknown as App;
    return { app, created };
  }

  it("skips a dot-folder that is on disk but missing from a stale tree", async () => {
    const { app, created } = makeApp({ disk: [".agentic-plugins"] });

    await ensureVaultFolder(app, ".agentic-plugins/user/skills");

    expect(created).toEqual([".agentic-plugins/user", ".agentic-plugins/user/skills"]);
  });

  it("absorbs a lost creation race when the folder really landed", async () => {
    const { app, created } = makeApp({ raceOn: "a/b" });

    await ensureVaultFolder(app, "a/b/c");

    expect(created).toEqual(["a", "a/b/c"]);
  });

  it("throws when a file occupies a folder segment", async () => {
    const { app } = makeApp({ files: ["a"] });

    await expect(ensureVaultFolder(app, "a/b")).rejects.toThrow("Folder already exists.");
  });
});
