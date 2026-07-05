import { describe, expect, it } from "vitest";
import {
  formatExternalRootLabel,
  formatWorkingDirLabel,
  WorkingDirectoryWorkflowController,
} from "../src/ui/working-directory-workflow-controller";
import type { ActionRow, WorkflowRenderer } from "../src/ui/workflow-renderer";

type RenderCall =
  | { type: "clear" }
  | { type: "info"; title: string; entries: Array<[string, string]> }
  | { type: "error"; message: string }
  | { type: "actions"; title: string; subtitle: string; items: ActionRow[] };

function renderer(calls: RenderCall[]): WorkflowRenderer {
  return {
    clear: () => calls.push({ type: "clear" }),
    info: (title, entries) => calls.push({ type: "info", title, entries }),
    error: (message) => calls.push({ type: "error", message }),
    actionList: (title, subtitle, items) => calls.push({ type: "actions", title, subtitle, items }),
  };
}

function makeController(
  options: {
    dirs?: string[];
    folders?: string[];
    activeFolder?: string;
    vaultBasePath?: string;
    externalAvailable?: boolean;
    externalRoot?: { enabled: boolean; rootPath: string };
  } = {},
): {
  controller: WorkingDirectoryWorkflowController;
  calls: RenderCall[];
  dirs: string[];
  externalRoot: { enabled: boolean; rootPath: string };
  saved: string[];
  changed: string[];
  picks: string[];
} {
  const calls: RenderCall[] = [];
  const dirs = options.dirs ?? [];
  const folders = new Set(options.folders ?? ["Notes", "Projects/Alpha"]);
  const externalRoot = options.externalRoot ?? { enabled: false, rootPath: "" };
  const saved: string[] = [];
  const changed: string[] = [];
  const picks: string[] = [];
  return {
    calls,
    dirs,
    externalRoot,
    saved,
    changed,
    picks,
    controller: new WorkingDirectoryWorkflowController({
      workingDirs: () => dirs,
      folderExists: (path) => folders.has(path),
      externalRoot: () => externalRoot,
      setExternalRoot: (path) => {
        externalRoot.enabled = path !== null;
        externalRoot.rootPath = path ?? "";
      },
      canUseExternalRoot: () => options.externalAvailable ?? false,
      activeFolder: () => options.activeFolder ?? "",
      vaultBasePath: () => options.vaultBasePath ?? null,
      saveSettings: async () => {
        saved.push("save");
      },
      afterChange: () => {
        changed.push("changed");
      },
      pickWorkingDir: () => picks.push("working"),
      pickFolderAttachment: () => picks.push("attachment"),
      renderer: renderer(calls),
    }),
  };
}

describe("WorkingDirectoryWorkflowController", () => {
  it("normalizes and grants real folders", async () => {
    const ctx = makeController();

    await ctx.controller.runAddDir("Notes/");

    expect(ctx.dirs).toEqual(["Notes"]);
    expect(ctx.saved).toEqual(["save"]);
    expect(ctx.changed).toEqual(["changed"]);
    expect(ctx.calls).toContainEqual({
      type: "info",
      title: "Working directory",
      entries: [["Notes", "Granted - the agent auto-runs inside it and asks before touching anything outside."]],
    });
  });

  it("maps slash to the vault-root grant", async () => {
    const ctx = makeController();

    await ctx.controller.add("/");

    expect(ctx.dirs).toEqual([""]);
    expect(ctx.calls).toContainEqual({
      type: "info",
      title: "Working directory",
      entries: [["/ (vault root)", "Granted - the agent auto-runs inside it and asks before touching anything outside."]],
    });
  });

  it("resolves shell-style relative paths against the active note folder", async () => {
    const ctx = makeController({
      activeFolder: "Projects/Alpha/Notes",
      folders: ["Projects/Alpha"],
    });

    await ctx.controller.add("../");

    expect(ctx.dirs).toEqual(["Projects/Alpha"]);
    expect(ctx.saved).toEqual(["save"]);
  });

  it("accepts absolute filesystem paths as working directories when they point inside the vault", async () => {
    const inside = makeController({
      vaultBasePath: "/home/alex/NotesVault",
      folders: ["Projects/Alpha"],
    });

    await inside.controller.add("/home/alex/NotesVault/Projects/Alpha");

    expect(inside.dirs).toEqual(["Projects/Alpha"]);

    const root = makeController({
      vaultBasePath: "/home/alex/NotesVault",
      folders: [""],
    });

    await root.controller.add("/home/alex/NotesVault");

    expect(root.dirs).toEqual([""]);
  });

  it("configures an external workspace root for absolute filesystem paths outside the vault", async () => {
    const outside = makeController({
      vaultBasePath: "/home/alex/NotesVault",
      externalAvailable: true,
    });

    await outside.controller.add("/home/alex/workspace");

    expect(outside.dirs).toEqual([]);
    expect(outside.externalRoot).toEqual({ enabled: true, rootPath: "/home/alex/workspace" });
    expect(outside.saved).toEqual(["save"]);
    expect(outside.changed).toEqual(["changed"]);
    expect(outside.calls).toContainEqual({
      type: "info",
      title: "External workspace root",
      entries: [
        [
          "/home/alex/workspace",
          "Enabled - the agent can inspect it read-only with approval using external_inspect.",
        ],
      ],
    });
  });

  it("keeps rejecting outside absolute filesystem paths when external roots are unavailable", async () => {
    const outside = makeController({
      vaultBasePath: "/home/alex/NotesVault",
    });

    await outside.controller.add("/home/alex/workspace");

    expect(outside.calls).toContainEqual({
      type: "error",
      message:
        'Folder path "/home/alex/workspace" is outside this vault. Working directories must be inside "/home/alex/NotesVault".',
    });
    expect(outside.saved).toEqual([]);
  });

  it("rejects invalid paths and missing folders without saving", async () => {
    const invalid = makeController();
    await invalid.controller.add("../outside");
    expect(invalid.calls).toContainEqual({ type: "error", message: 'Folder path "../outside" points outside this vault.' });
    expect(invalid.saved).toEqual([]);

    const missing = makeController();
    await missing.controller.add("Missing");
    expect(missing.calls).toContainEqual({ type: "error", message: '"Missing" is not a folder in this vault.' });
    expect(missing.saved).toEqual([]);
  });

  it("reports duplicates without mutating settings", async () => {
    const ctx = makeController({ dirs: ["Notes"] });

    await ctx.controller.add("Notes");

    expect(ctx.dirs).toEqual(["Notes"]);
    expect(ctx.saved).toEqual([]);
    expect(ctx.calls).toContainEqual({
      type: "info",
      title: "Working directory",
      entries: [["Notes", "Already a working directory."]],
    });
  });

  it("renders folder actions and delegates pickers", () => {
    const ctx = makeController({ dirs: ["Notes", ""], externalRoot: { enabled: true, rootPath: "/workspace/code" } });

    ctx.controller.showFolderMenu();
    const menu = ctx.calls.find((call): call is Extract<RenderCall, { type: "actions" }> => call.type === "actions");
    menu?.items[0]?.onClick();
    menu?.items[1]?.onClick();
    expect(ctx.picks).toEqual(["working", "attachment"]);

    ctx.calls.length = 0;
    ctx.controller.showWorkingDirs();
    const list = ctx.calls.find((call): call is Extract<RenderCall, { type: "actions" }> => call.type === "actions");
    expect(list?.items.map((item) => item.label)).toEqual([
      "Add working directory...",
      "Notes",
      "/ (vault root)",
      "/workspace/code",
    ]);
  });

  it("removes an existing grant and ignores absent grants", async () => {
    const ctx = makeController({ dirs: ["Notes", "Projects/Alpha"] });

    await ctx.controller.remove("Notes");
    await ctx.controller.remove("Missing");

    expect(ctx.dirs).toEqual(["Projects/Alpha"]);
    expect(ctx.saved).toEqual(["save"]);
    expect(ctx.changed).toEqual(["changed"]);
  });

  it("removes a configured external workspace root", async () => {
    const ctx = makeController({ externalRoot: { enabled: true, rootPath: "/workspace/code" } });

    await ctx.controller.removeExternalRoot();

    expect(ctx.externalRoot).toEqual({ enabled: false, rootPath: "" });
    expect(ctx.saved).toEqual(["save"]);
    expect(ctx.changed).toEqual(["changed"]);
  });

  it("formats root and folder labels", () => {
    expect(formatWorkingDirLabel("")).toBe("/ (vault root)");
    expect(formatWorkingDirLabel("Notes")).toBe("Notes");
    expect(formatExternalRootLabel("/workspace/code/")).toBe("/workspace/code");
  });
});
