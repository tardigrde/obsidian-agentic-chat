import { describe, expect, it } from "vitest";
import { TFile, type App } from "obsidian";
import { applyUndo } from "../src/agent/undo";
import { createRenameTool } from "../src/tools/vault/write-tools";

interface ConfigSet {
  key: string;
  value: unknown;
}

/**
 * Minimal app whose vault config defaults to the prompt path
 * (`alwaysUpdateLinks` off). `renameFile` records the config value it observed,
 * so a test can prove the toggle happened before the call and was restored
 * after it.
 */
function makeApp(
  initial: boolean,
  options: {
    failRename?: boolean;
    files?: string[];
    beforeRename?: (target: TFile) => Promise<void>;
  } = {},
) {
  const files = new Map<string, TFile>();
  for (const path of options.files ?? ["Old.md"]) {
    const file = new TFile();
    file.path = path;
    file.name = path;
    files.set(path, file);
  }

  const trace: string[] = [];
  const configSets: ConfigSet[] = [];
  let config: boolean = initial;
  let renameCalls = 0;

  const app = {
    vault: {
      getFileByPath: (path: string) => files.get(path) ?? null,
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      getFiles: () => [...files.values()],
      getAllLoadedFiles: () => [...files.values()],
      getConfig: (key: string) => {
        trace.push(`get:${key}`);
        return config;
      },
      setConfig: (key: string, value: unknown) => {
        trace.push(`set:${key}=${String(value)}`);
        configSets.push({ key, value });
        config = value === true;
      },
    },
    fileManager: {
      renameFile: async (target: TFile, newPath: string) => {
        renameCalls += 1;
        await options.beforeRename?.(target);
        trace.push(`rename:${newPath}:alwaysUpdateLinks=${String(config)}`);
        if (options.failRename) throw new Error("rename refused");
        files.delete(target.path);
        target.path = newPath;
        target.name = newPath;
        files.set(newPath, target);
      },
    },
  } as unknown as App;

  return {
    app,
    trace,
    configSets,
    renameCalls: () => renameCalls,
    config: () => config,
    /** Move a file without the guard, to set up an already-renamed vault. */
    moveFile: (from: string, to: string) => {
      const file = files.get(from);
      if (!file) throw new Error(`${from} is not seeded`);
      files.delete(from);
      file.path = to;
      files.set(to, file);
    },
  };
}

async function waitFor(predicate: () => boolean, label = "condition"): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("vault rename link-prompt guard", function () {
  it("updates links once and restores the setting when it is off", async function () {
    const fake = makeApp(false);
    const tool = createRenameTool(fake.app, () => false);

    const result = await tool.execute("rename-1", { path: "Old.md", newPath: "New.md" });

    expect(result.content).toEqual([{ type: "text", text: "Renamed Old.md to New.md." }]);
    expect(fake.renameCalls()).toBe(1);
    expect(fake.configSets).toEqual([
      { key: "alwaysUpdateLinks", value: true },
      { key: "alwaysUpdateLinks", value: false },
    ]);
    // The rename must run while the auto-update flag is on, or Obsidian opens
    // its "Update links?" modal and the turn blocks forever.
    expect(fake.trace).toEqual([
      "get:alwaysUpdateLinks",
      "set:alwaysUpdateLinks=true",
      "rename:New.md:alwaysUpdateLinks=true",
      "set:alwaysUpdateLinks=false",
    ]);
    expect(fake.config()).toBe(false);
  });

  it("leaves the setting alone when auto-update is already on", async function () {
    const fake = makeApp(true);
    const tool = createRenameTool(fake.app, () => false);

    await tool.execute("rename-2", { path: "Old.md", newPath: "New.md" });

    expect(fake.renameCalls()).toBe(1);
    expect(fake.configSets).toEqual([]);
    expect(fake.trace).toEqual(["get:alwaysUpdateLinks", "rename:New.md:alwaysUpdateLinks=true"]);
  });

  it("restores the setting when the rename throws", async function () {
    const fake = makeApp(false, { failRename: true });
    const tool = createRenameTool(fake.app, () => false);

    await expect(tool.execute("rename-3", { path: "Old.md", newPath: "New.md" })).rejects.toThrow("rename refused");

    expect(fake.renameCalls()).toBe(1);
    expect(fake.config()).toBe(false);
    expect(fake.configSets).toEqual([
      { key: "alwaysUpdateLinks", value: true },
      { key: "alwaysUpdateLinks", value: false },
    ]);
  });

  it("undo uses the same guard", async function () {
    const fake = makeApp(false);
    fake.moveFile("Old.md", "New.md");

    const summary = await applyUndo(fake.app, { kind: "rename", from: "Old.md", to: "New.md" });

    expect(summary).toBe("Renamed New.md back to Old.md.");
    expect(fake.renameCalls()).toBe(1);
    expect(fake.configSets).toEqual([
      { key: "alwaysUpdateLinks", value: true },
      { key: "alwaysUpdateLinks", value: false },
    ]);
    expect(fake.trace).toContain("rename:Old.md:alwaysUpdateLinks=true");
  });

  it("waits for an in-flight toggle rename instead of racing its restore", async function () {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = makeApp(false, {
      files: ["A.md", "B.md"],
      beforeRename: async (target) => {
        if (target.path === "A.md") await gate;
      },
    });
    const tool = createRenameTool(fake.app, () => false);

    const first = tool.execute("rename-a", { path: "A.md", newPath: "A2.md" });
    await waitFor(() => fake.renameCalls() === 1);
    const second = tool.execute("rename-b", { path: "B.md", newPath: "B2.md" });
    await Promise.resolve();
    // The first rename is paused inside renameFile with the flag on. The
    // second must wait in the queue, not see the flag and bypass it.
    expect(fake.renameCalls()).toBe(1);
    expect(fake.config()).toBe(true);

    release();
    await Promise.all([first, second]);

    expect(fake.renameCalls()).toBe(2);
    expect(fake.config()).toBe(false);
    expect(fake.trace).toEqual([
      "get:alwaysUpdateLinks",
      "set:alwaysUpdateLinks=true",
      "rename:A2.md:alwaysUpdateLinks=true",
      "set:alwaysUpdateLinks=false",
      "get:alwaysUpdateLinks",
      "set:alwaysUpdateLinks=true",
      "rename:B2.md:alwaysUpdateLinks=true",
      "set:alwaysUpdateLinks=false",
    ]);
  });

  it("never lets two toggled renames interleave", async function () {
    const fake = makeApp(false, { files: ["A.md", "B.md"] });
    const tool = createRenameTool(fake.app, () => false);

    await Promise.all([
      tool.execute("rename-a", { path: "A.md", newPath: "A2.md" }),
      tool.execute("rename-b", { path: "B.md", newPath: "B2.md" }),
    ]);

    expect(fake.renameCalls()).toBe(2);
    // The first rename finishes (toggle on, rename, toggle off) before the
    // second one touches the setting, so neither ever sees a restored flag.
    expect(fake.trace).toEqual([
      "get:alwaysUpdateLinks",
      "set:alwaysUpdateLinks=true",
      "rename:A2.md:alwaysUpdateLinks=true",
      "set:alwaysUpdateLinks=false",
      "get:alwaysUpdateLinks",
      "set:alwaysUpdateLinks=true",
      "rename:B2.md:alwaysUpdateLinks=true",
      "set:alwaysUpdateLinks=false",
    ]);
  });
});
