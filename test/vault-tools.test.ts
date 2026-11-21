import { describe, expect, it } from "vitest";
import { TFile, TFolder, type App } from "obsidian";
import { MUTATING_TOOLS } from "../src/tools/tool-contracts";
import { createVaultTools } from "../src/tools/vault-tools";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { IgnoreMatcher } from "../src/vault/ignore";
import { ReadMemo } from "../src/vault/read-memo";
import { unwrapToolOutput } from "../src/tools/tool-output-wrapper";

interface FileSpec {
  content?: string;
  /** Outbound resolved links (target path -> count). */
  links?: Record<string, number>;
  /** Cached frontmatter as Obsidian's metadataCache would expose it. */
  frontmatter?: Record<string, unknown>;
}

interface VaultSpec {
  files: Record<string, FileSpec>;
  folders?: string[];
  /** Use a Map shape for getBacklinksForFile().data to exercise the defensive path. */
  backlinksAsMap?: boolean;
  /** File Obsidian reports as active even when a non-Markdown pane has focus. */
  activeFile?: string;
  /** Markdown view file, when the active pane is an editor. */
  activeViewFile?: string;
  selection?: string;
}

/**
 * Minimal Obsidian `App` stand-in tailored to the graph + frontmatter tools.
 * Builds resolvedLinks/backlinks from the per-file `links` spec.
 */
function makeApp(spec: VaultSpec): App {
  const files = new Map<string, TFile>();
  const folders = new Map<string, TFolder>();
  const contents = new Map<string, string>();
  const frontmatterCache = new Map<string, Record<string, unknown>>();
  const root = new TFolder();
  root.path = "/";
  root.name = "";
  root.children = [];
  folders.set("/", root);

  function ensureFolder(folderPath: string): TFolder {
    const normalized = folderPath.replace(/^\/+|\/+$/g, "");
    const key = normalized || "/";
    const existing = folders.get(key);
    if (existing) return existing;
    const parentPath = normalized.includes("/") ? normalized.slice(0, normalized.lastIndexOf("/")) : "/";
    const parent = ensureFolder(parentPath);
    const folder = new TFolder();
    folder.path = normalized;
    folder.name = normalized.split("/").pop() ?? normalized;
    folder.children = [];
    folder.parent = parent;
    parent.children.push(folder);
    folders.set(normalized, folder);
    return folder;
  }

  for (const folder of spec.folders ?? []) ensureFolder(folder);

  for (const [path, file] of Object.entries(spec.files)) {
    const tfile = new TFile();
    tfile.path = path;
    tfile.name = path.split("/").pop() ?? path;
    tfile.extension = tfile.name.includes(".") ? tfile.name.split(".").pop() ?? "" : "";
    // The read tool guards on file size; surface it so the guardrail is testable.
    (tfile as unknown as { stat: { size: number } }).stat = { size: file.content?.length ?? 0 };
    const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
    const parent = ensureFolder(parentPath);
    tfile.parent = parent;
    parent.children.push(tfile);
    files.set(path, tfile);
    contents.set(path, file.content ?? "");
    if (file.frontmatter) frontmatterCache.set(path, file.frontmatter);
  }

  const resolvedLinks: Record<string, Record<string, number>> = {};
  for (const [path, file] of Object.entries(spec.files)) {
    resolvedLinks[path] = { ...(file.links ?? {}) };
  }

  // Derive backlinks by inverting resolvedLinks.
  function backlinksFor(target: string): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const [source, targets] of Object.entries(resolvedLinks)) {
      const count = targets[target];
      if (count) out[source] = Array.from({ length: count }, (_, i) => ({ ref: i }));
    }
    return out;
  }

  return {
    vault: {
      getFileByPath: (path: string) => files.get(path) ?? null,
      getFiles: () => [...files.values()],
      getAllLoadedFiles: () => [...folders.values(), ...files.values()],
      getFolderByPath: (path: string) => folders.get(path || "/") ?? null,
      getAbstractFileByPath: (path: string) => files.get(path) ?? folders.get(path || "/") ?? null,
      getRoot: () => root,
      cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
      process: async (file: TFile, fn: (content: string) => string) => {
        const next = fn(contents.get(file.path) ?? "");
        contents.set(file.path, next);
        return next;
      },
    },
    metadataCache: {
      resolvedLinks,
      getBacklinksForFile: (file: TFile) => {
        const record = backlinksFor(file.path);
        return { data: spec.backlinksAsMap ? new Map(Object.entries(record)) : record };
      },
      getFileCache: (file: TFile) => {
        const fm = frontmatterCache.get(file.path);
        return fm ? { frontmatter: { ...fm } } : null;
      },
    },
    fileManager: {
      // Mirror processFrontMatter: mutate a parsed object, then persist it.
      processFrontMatter: async (file: TFile, fn: (fm: Record<string, unknown>) => void) => {
        const current = { ...(frontmatterCache.get(file.path) ?? {}) };
        fn(current);
        frontmatterCache.set(file.path, current);
      },
      trashFile: async (entry: TFile | TFolder) => {
        if (entry instanceof TFile) {
          files.delete(entry.path);
          contents.delete(entry.path);
        } else {
          folders.delete(entry.path);
        }
        const siblings = entry.parent?.children;
        const index = siblings?.indexOf(entry) ?? -1;
        if (siblings && index >= 0) siblings.splice(index, 1);
      },
    },
    workspace: {
      getActiveFile: () => (spec.activeFile ? files.get(spec.activeFile) ?? null : null),
      getActiveViewOfType: () => {
        const file = spec.activeViewFile ? files.get(spec.activeViewFile) ?? null : null;
        return file
          ? {
              file,
              editor: {
                getSelection: () => spec.selection ?? "",
              },
            }
          : null;
      },
    },
  } as unknown as App;
}

/** vault_inspect actions that replaced the old standalone inspect tools. */
const INSPECT_ACTIONS: Record<string, string> = {
  ls: "list",
  search: "search",
  get_active_note: "active_note",
  local_graph: "local_graph",
  get_properties: "properties",
};

/**
 * A real vault tool by name. The old standalone inspect names (ls, search,
 * get_active_note, local_graph, get_properties) map onto the matching
 * vault_inspect action, so their behavior stays covered through the one tool
 * the model gets.
 */
function getTool(app: App, name: string, isIgnored?: IgnoreMatcher): AgentTool {
  const tools = createVaultTools(app, isIgnored);
  const action = INSPECT_ACTIONS[name];
  const toolName = action ? "vault_inspect" : name;
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`tool not found: ${name}`);
  if (!action) return tool;
  return {
    ...tool,
    execute: (id, params, signal) => {
      const raw = { ...(params as Record<string, unknown>) };
      // The old search tool's "query" maps straight; nothing else is renamed.
      return tool.execute(id, { ...raw, action } as never, signal);
    },
  };
}

async function run(tool: AgentTool, params: unknown): Promise<{ text: string; details: Record<string, unknown> }> {
  const result = await tool.execute("call-1", params as never);
  const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  return { text, details: result.details as Record<string, unknown> };
}

const ignore = (...paths: string[]): IgnoreMatcher => {
  const set = new Set(paths);
  return (path) => set.has(path);
};

describe("vault tool surface", () => {
  it("pins tool names, order, and parameter keys", () => {
    const tools = createVaultTools({} as App);
    const shapes = tools.map((tool) => ({
      name: tool.name,
      keys: Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties),
    }));

    expect(shapes).toEqual([
      { name: "read", keys: ["path", "startLine", "endLine", "offset", "limit"] },
      {
        name: "vault_inspect",
        keys: [
          "action",
          "path",
          "query",
          "kind",
          "includeContent",
          "includeSelection",
          "caseSensitive",
          "regex",
          "maxResults",
          "maxMatches",
        ],
      },
      { name: "write", keys: ["path", "content"] },
      { name: "edit", keys: ["path", "edits"] },
      { name: "rename", keys: ["path", "newPath"] },
      { name: "delete", keys: ["path", "recursive"] },
      { name: "set_properties", keys: ["path", "properties"] },
    ]);
  });
});

describe("MUTATING_TOOLS", () => {
  it("includes set_properties but not the read-only graph/property tools", () => {
    expect(MUTATING_TOOLS.has("set_properties")).toBe(true);
    expect(MUTATING_TOOLS.has("vault_inspect")).toBe(false);
    expect(MUTATING_TOOLS.has("get_properties")).toBe(false);
    expect(MUTATING_TOOLS.has("get_backlinks")).toBe(false);
    expect(MUTATING_TOOLS.has("get_links")).toBe(false);
    expect(MUTATING_TOOLS.has("local_graph")).toBe(false);
  });
});

describe("vault_inspect", () => {
  function getDefaultTool(app: App, name: string, isIgnored?: IgnoreMatcher): AgentTool {
    const tool = createVaultTools(app, isIgnored).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    return tool;
  }

  it("consolidates search into one default read-only meta-tool while hiding ignored paths", async () => {
    const app = makeApp({
      files: {
        "Projects/Needle.md": { content: "first needle" },
        "Projects/Other.md": { content: "second needle" },
        "Private/Needle.md": { content: "private needle" },
      },
    });

    const { text, details } = await run(getDefaultTool(app, "vault_inspect", ignore("Private/Needle.md")), {
      action: "search",
      query: "needle",
      path: "Projects",
    });

    expect(text).toContain("File name matches (1):\nProjects/Needle.md");
    expect(text).toContain("Projects/Other.md:1: second needle");
    expect(text).not.toContain("Private");
    expect(details).toMatchObject({
      inspectAction: "search",
      query: "needle",
      path: "Projects",
    });
  });

  it("consolidates local graph and property reads without making them mutating", async () => {
    const app = makeApp({
      files: {
        "Target.md": { frontmatter: { status: "active" }, links: { "Next.md": 1 } },
        "Next.md": { links: { "Target.md": 1 } },
      },
    });
    const tool = getDefaultTool(app, "vault_inspect");

    const graph = await run(tool, { action: "local_graph", path: "Target.md" });
    const properties = await run(tool, { action: "properties", path: "Target.md" });

    expect(graph.details).toMatchObject({ inspectAction: "local_graph" });
    expect(graph.text).toContain("Inbound (1):");
    expect(graph.text).toContain("Outbound (1):");
    expect(properties.details).toMatchObject({ inspectAction: "properties" });
    expect(properties.text).toContain('"status": "active"');
  });

  it("rejects missing action-specific inputs before delegating", async () => {
    const app = makeApp({ files: { "A.md": { content: "alpha" } } });
    const tool = getDefaultTool(app, "vault_inspect");

    await expect(run(tool, { action: "search" })).rejects.toThrow(/query is required/i);
    await expect(run(tool, { action: "properties" })).rejects.toThrow(/path is required/i);
    await expect(run(tool, { action: "unknown" })).rejects.toThrow(/action must be/i);
  });

  it("reads the active file even when the chat view owns focus", async () => {
    const app = makeApp({
      activeFile: "Scratch.md",
      files: {
        "Scratch.md": { content: "# Scratch\n\nThe chat pane is focused.\n" },
      },
    });
    const tool = getDefaultTool(app, "vault_inspect");

    const { text, details } = await run(tool, { action: "active_note", includeContent: true, includeSelection: true });

    expect(text).toContain("Active note: Scratch.md");
    expect(text).toContain("The chat pane is focused.");
    expect(text).toContain("Selection:\n(no selection)");
    expect(details).toMatchObject({
      inspectAction: "active_note",
      path: "Scratch.md",
      hasSelection: false,
    });
  });

  it("keeps ignored active files hidden", async () => {
    const app = makeApp({
      activeFile: "Private.md",
      files: {
        "Private.md": { content: "secret" },
      },
    });
    const tool = getDefaultTool(app, "vault_inspect", ignore("Private.md"));

    await expect(run(tool, { action: "active_note", includeContent: true })).rejects.toThrow(/No active Markdown note/);
  });
});

describe("search", () => {
  it("searches file names and contents through one default tool while hiding ignored paths", async () => {
    const app = makeApp({
      files: {
        "Projects/Needle.md": { content: "first needle" },
        "Projects/Other.md": { content: "second needle" },
        "Private/Needle.md": { content: "private needle" },
      },
    });

    const { text, details } = await run(getTool(app, "search", ignore("Private/Needle.md")), {
      query: "needle",
      path: "Projects",
    });

    expect(text).toContain("File name matches (1):\nProjects/Needle.md");
    expect(text).toContain("Content matches (2):");
    expect(text).toContain("Projects/Needle.md:1: first needle");
    expect(text).toContain("Projects/Other.md:1: second needle");
    expect(text).not.toContain("Private");
    expect(details).toMatchObject({
      query: "needle",
      kind: "both",
      path: "Projects",
      fileCount: 1,
      fileTruncated: false,
      contentCount: 2,
      contentTruncated: false,
    });
  });

  it("keeps separate result caps for path and content search", async () => {
    const app = makeApp({
      files: {
        "One-Needle.md": { content: "needle one" },
        "Two-Needle.md": { content: "needle two" },
      },
    });

    const { text, details } = await run(getTool(app, "search"), {
      query: "needle",
      maxResults: 1,
      maxMatches: 1,
    });

    expect(text).toContain("[File results truncated.]");
    expect(text).toContain("[Matches truncated.]");
    expect(text).toContain("One-Needle.md");
    expect(text).not.toContain("Two-Needle.md");
    expect(details).toMatchObject({
      fileCount: 2,
      fileTruncated: true,
      contentCount: 1,
      contentTruncated: true,
    });
  });

});



describe("local_graph", () => {
  const spec: VaultSpec = {
    files: {
      "Hub.md": { links: { "Out.md": 1 } },
      "In.md": { links: { "Hub.md": 1 } },
      "Out.md": {},
    },
  };

  it("returns both inbound and outbound neighborhoods", async () => {
    const app = makeApp(spec);
    const { text, details } = await run(getTool(app, "local_graph"), { path: "Hub.md" });
    expect(details.inbound).toEqual(["In.md"]);
    expect(details.outbound).toEqual(["Out.md"]);
    expect(text).toContain("Inbound (1):");
    expect(text).toContain("Outbound (1):");
  });

  it("filters ignored notes on both sides", async () => {
    const app = makeApp(spec);
    const { details } = await run(getTool(app, "local_graph", ignore("In.md", "Out.md")), { path: "Hub.md" });
    expect(details.inbound).toEqual([]);
    expect(details.outbound).toEqual([]);
  });

  it("reports an ignored note as private (U4 #11)", async () => {
    const app = makeApp(spec);
    await expect(run(getTool(app, "local_graph", ignore("Hub.md")), { path: "Hub.md" })).rejects.toThrow(
      /is private \(excluded in settings\)/,
    );
  });

  it("reports a missing note as not found", async () => {
    const app = makeApp(spec);
    await expect(run(getTool(app, "local_graph"), { path: "Missing.md" })).rejects.toThrow(/not found/);
  });
});

describe("get_properties", () => {
  it("reads frontmatter from the metadata cache", async () => {
    const app = makeApp({ files: { "Note.md": { frontmatter: { status: "active", tags: ["a", "b"] } } } });
    const { text, details } = await run(getTool(app, "get_properties"), { path: "Note.md" });
    expect(details.keys).toEqual(["status", "tags"]);
    expect(JSON.parse(unwrapToolOutput(text))).toEqual({ status: "active", tags: ["a", "b"] });
  });

  it("strips the internal position field from cached frontmatter", async () => {
    const app = makeApp({
      files: { "Note.md": { frontmatter: { status: "active", position: { start: 0 } } } },
    });
    const { details } = await run(getTool(app, "get_properties"), { path: "Note.md" });
    expect(details.keys).toEqual(["status"]);
  });

  it("falls back to parsing the YAML block when the cache is empty", async () => {
    const app = makeApp({ files: { "Note.md": { content: "---\nstatus: draft\n---\n\nBody" } } });
    const { details, text } = await run(getTool(app, "get_properties"), { path: "Note.md" });
    expect(details.keys).toEqual(["status"]);
    expect(JSON.parse(unwrapToolOutput(text))).toEqual({ status: "draft" });
  });

  it("reports no frontmatter cleanly", async () => {
    const app = makeApp({ files: { "Note.md": { content: "Just a body" } } });
    const { text, details } = await run(getTool(app, "get_properties"), { path: "Note.md" });
    expect(unwrapToolOutput(text)).toBe("(no frontmatter properties)");
    expect(details.keys).toEqual([]);
  });

  it("reports an ignored note as private (U4 #11)", async () => {
    const app = makeApp({ files: { "Note.md": { frontmatter: { a: 1 } } } });
    await expect(run(getTool(app, "get_properties", ignore("Note.md")), { path: "Note.md" })).rejects.toThrow(
      /is private \(excluded in settings\)/,
    );
  });

  it("reports a missing note as not found", async () => {
    const app = makeApp({ files: {} });
    await expect(run(getTool(app, "get_properties"), { path: "Gone.md" })).rejects.toThrow(/not found/);
  });
});

describe("set_properties", () => {
  it("merges keys into existing frontmatter without touching others", async () => {
    const app = makeApp({ files: { "Note.md": { frontmatter: { status: "draft", keep: "me" } } } });
    const { text, details } = await run(getTool(app, "set_properties"), {
      path: "Note.md",
      properties: { status: "published", priority: 3 },
    });
    expect(details.set).toEqual(["status", "priority"]);
    expect(text).toContain("set status, priority");
    const after = await run(getTool(app, "get_properties"), { path: "Note.md" });
    expect(JSON.parse(unwrapToolOutput(after.text))).toEqual({ status: "published", keep: "me", priority: 3 });
  });

  it("deletes a key when its value is null", async () => {
    const app = makeApp({ files: { "Note.md": { frontmatter: { drop: "x", keep: "y" } } } });
    const { details, text } = await run(getTool(app, "set_properties"), {
      path: "Note.md",
      properties: { drop: null },
    });
    expect(details.deleted).toEqual(["drop"]);
    expect(text).toContain("deleted drop");
    const after = await run(getTool(app, "get_properties"), { path: "Note.md" });
    expect(JSON.parse(unwrapToolOutput(after.text))).toEqual({ keep: "y" });
  });

  it("creates frontmatter on a note that has none", async () => {
    const app = makeApp({ files: { "Note.md": { content: "Body only" } } });
    await run(getTool(app, "set_properties"), { path: "Note.md", properties: { tag: "new" } });
    const after = await run(getTool(app, "get_properties"), { path: "Note.md" });
    expect(JSON.parse(unwrapToolOutput(after.text))).toEqual({ tag: "new" });
  });

  it("reports an ignored note as private (U4 #11) and does not mutate it", async () => {
    const app = makeApp({ files: { "Note.md": { frontmatter: { a: 1 } } } });
    await expect(
      run(getTool(app, "set_properties", ignore("Note.md")), { path: "Note.md", properties: { a: 2 } }),
    ).rejects.toThrow(/is private \(excluded in settings\)/);
    const after = await run(getTool(app, "get_properties"), { path: "Note.md" });
    expect(JSON.parse(unwrapToolOutput(after.text))).toEqual({ a: 1 });
  });

  it("reports a missing note as not found", async () => {
    const app = makeApp({ files: {} });
    await expect(
      run(getTool(app, "set_properties"), { path: "Gone.md", properties: { a: 1 } }),
    ).rejects.toThrow(/not found/);
  });
});

describe("read — dedup + size guardrail", () => {
  it("returns an actionable error when the target is a folder, not a note", async () => {
    const app = makeApp({ files: { "Note.md": { content: "hello" } }, folders: ["Inbox"] });
    const read = createVaultTools(app).find((t) => t.name === "read")!;
    await expect(run(read, { path: "Inbox/" })).rejects.toThrow(/is a folder — use vault_inspect with action "list"/i);
    await expect(run(read, { path: "Inbox" })).rejects.toThrow(/is a folder — use vault_inspect with action "list"/i);
  });

  it("U3 #9: refuses a binary file with a clear error instead of mangled text", async () => {
    const png = "\uFFFDPNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR\u0000\u0000\u0001\uFFFD\uFFFD\uFFFD";
    const app = makeApp({ files: { "700 Media/adulthood.png": { content: png }, "Data/blob.bin": { content: `abc\u0000\uFFFD\uFFFDdef` } } });
    const read = createVaultTools(app).find((t) => t.name === "read")!;
    await expect(run(read, { path: "700 Media/adulthood.png" })).rejects.toThrow(/binary file \(PNG image/i);
    await expect(run(read, { path: "700 Media/adulthood.png" })).rejects.toThrow(/attach/i);
    await expect(run(read, { path: "Data/blob.bin" })).rejects.toThrow(/binary/i);
  });

  it("reads a legacy-encoded text note (some U+FFFD) and a file named like an Object key", async () => {
    // cp1250 Hungarian decoded as UTF-8: only the accented letters turn into U+FFFD.
    const legacy = "Sz\uFFFDp nap van, a kert z\uFFFDld \uFFFDs a h\uFFFDz el\uFFFDtt \uFFFDll a fa.\n".repeat(30);
    const app = makeApp({ files: { "Old/napl\u00f3.md": { content: legacy }, "Notes/plan.constructor": { content: "plain text" } } });
    const read = createVaultTools(app).find((t) => t.name === "read")!;
    expect((await run(read, { path: "Old/napl\u00f3.md" })).text).toContain("kert");
    expect((await run(read, { path: "Notes/plan.constructor" })).text).toContain("plain text");
  });

  it("returns content on the first read, a pointer on the second identical read", async () => {
    const app = makeApp({ files: { "Note.md": { content: "hello world" } } });
    const memo = new ReadMemo();
    const read = createVaultTools(app, undefined, memo).find((t) => t.name === "read")!;
    const first = await run(read, { path: "Note.md" });
    expect(first.text).toContain("hello world");
    expect(first.details.deduplicated).toBeFalsy();
    const second = await run(read, { path: "Note.md" });
    expect(second.details.deduplicated).toBe(true);
    expect(second.text).not.toContain("hello world");
  });

  it("dedupes a range contained inside an earlier read and quotes the prior content", async () => {
    const app = makeApp({ files: { "Note.md": { content: "line1\nline2\nline3" } } });
    const memo = new ReadMemo();
    const read = createVaultTools(app, undefined, memo).find((t) => t.name === "read")!;
    const first = await run(read, { path: "Note.md" });
    expect(first.text).toContain("line2");
    const contained = await run(read, { path: "Note.md", offset: 2, limit: 1 });
    expect(contained.details.deduplicated).toBe(true);
    expect(contained.details.covered).toBe(true);
    expect(contained.text).toContain("Re-reading");
    expect(contained.text).not.toContain("Note.md lines");
    expect(contained.text).toContain("Previously served content");
    expect(contained.text).toContain("line2");
  });

  it("still allows a range outside the earlier read (pagination is not deduped)", async () => {
    const app = makeApp({ files: { "Note.md": { content: "line1\nline2" } } });
    const memo = new ReadMemo();
    const read = createVaultTools(app, undefined, memo).find((t) => t.name === "read")!;
    const first = await run(read, { path: "Note.md", offset: 1, limit: 1 });
    expect(first.text).toContain("line1");
    const next = await run(read, { path: "Note.md", offset: 2, limit: 1 });
    expect(next.details.deduplicated).toBeFalsy();
    expect(next.text).toContain("line2");
  });

  it("dedupes a sub-range only when the file has not changed since the wider read", async () => {
    const app = makeApp({ files: { "Note.md": { content: "a\nb\nc\nd" } } });
    const memo = new ReadMemo();
    const read = createVaultTools(app, undefined, memo).find((t) => t.name === "read")!;
    await run(read, { path: "Note.md", offset: 1, limit: 3 });
    // The file changed on disk: the wider read's content is stale, so re-read.
    const file = app.vault.getAbstractFileByPath("Note.md") as TFile;
    (file as unknown as { stat: { size: number; mtime: number } }).stat = {
      size: 20,
      mtime: 7,
    };
    const afterChange = await run(read, { path: "Note.md", offset: 1, limit: 2 });
    expect(afterChange.details.deduplicated).toBeFalsy();
    expect(afterChange.text).toContain("b");
  });

  it("reads explicit startLine/endLine ranges and dedupes equivalent offset/limit ranges", async () => {
    const app = makeApp({ files: { "Note.md": { content: "one\ntwo\nthree\nfour" } } });
    const memo = new ReadMemo();
    const read = createVaultTools(app, undefined, memo).find((t) => t.name === "read")!;

    const first = await run(read, { path: "Note.md", startLine: 2, endLine: 3 });
    expect(first.text).toContain("Note.md lines 2-3 of 4");
    expect(first.text).toContain("two\nthree");
    expect(first.details).toMatchObject({ startLine: 2, endLine: 3, totalLines: 4 });

    const equivalent = await run(read, { path: "Note.md", offset: 2, limit: 2 });
    expect(equivalent.details.deduplicated).toBe(true);
  });

  it("refuses a bulk read of a very large file with pagination guidance", async () => {
    const app = makeApp({ files: { "Big.md": { content: "x".repeat(60_000) } } });
    const read = createVaultTools(app).find((t) => t.name === "read")!;
    const result = await run(read, { path: "Big.md" });
    expect(result.details.tooLarge).toBe(true);
    expect(result.text).toContain("offset/limit");
  });

  it("allows paginating a very large file", async () => {
    const app = makeApp({ files: { "Big.md": { content: "x".repeat(60_000) } } });
    const read = createVaultTools(app).find((t) => t.name === "read")!;
    const result = await run(read, { path: "Big.md", offset: 1, limit: 10 });
    expect(result.details.tooLarge).toBeUndefined();
  });

  it("allows explicit startLine/endLine ranges for a very large file", async () => {
    const app = makeApp({ files: { "Big.md": { content: "x\n".repeat(60_000) } } });
    const read = createVaultTools(app).find((t) => t.name === "read")!;
    const result = await run(read, { path: "Big.md", startLine: 2, endLine: 3 });
    expect(result.details.tooLarge).toBeUndefined();
    expect(result.details).toMatchObject({ startLine: 2, endLine: 3, totalLines: 60_001 });
    expect(result.text).toContain("Big.md lines 2-3");
  });

  it("does not memoize a read that fails (missing file), so a retry isn't deduped", async () => {
    const app = makeApp({ files: {} });
    const memo = new ReadMemo();
    const read = createVaultTools(app, undefined, memo).find((t) => t.name === "read")!;
    await expect(run(read, { path: "Ghost.md" })).rejects.toThrow(/not found/);
    expect(memo.has({ path: "Ghost.md" })).toBe(false);
  });

  it("does not memoize a read refused by the size guardrail", async () => {
    const app = makeApp({ files: { "Big.md": { content: "x".repeat(60_000) } } });
    const memo = new ReadMemo();
    const read = createVaultTools(app, undefined, memo).find((t) => t.name === "read")!;
    const result = await run(read, { path: "Big.md" });
    expect(result.details.tooLarge).toBe(true);
    expect(memo.has({ path: "Big.md" })).toBe(false);
  });
});

describe("delete", () => {
  it("moves an empty folder to trash through the delete tool", async () => {
    const app = makeApp({ folders: ["Empty"], files: {} });
    const del = getTool(app, "delete");

    const result = await run(del, { path: "Empty" });

    expect(unwrapToolOutput(result.text)).toBe("Moved Empty to trash.");
    expect(result.details).toMatchObject({ path: "Empty", kind: "folder" });
    expect(app.vault.getAbstractFileByPath("Empty")).toBeNull();
  });

  /**
   * Obsidian's system trash can return without moving anything (a Linux desktop
   * with no trash service). Reproduced in real Obsidian by
   * test/e2e/specs/trash-fallback.e2e.ts; this pins the fallback order.
   */
  function withNoOpSystemTrash(app: App, onDisk: Set<string>, options: { localTrashFails?: boolean } = {}) {
    const calls: string[] = [];
    (app.fileManager as unknown as { trashFile: (file: TFile) => Promise<void> }).trashFile = async () => {
      calls.push("trashFile");
    };
    (app.vault as unknown as { adapter: unknown }).adapter = {
      exists: async (path: string) => onDisk.has(path),
      trashLocal: async (path: string) => {
        calls.push("trashLocal");
        if (options.localTrashFails) throw new Error("no .trash");
        onDisk.delete(path);
      },
      remove: async (path: string) => {
        calls.push("remove");
        onDisk.delete(path);
      },
      rmdir: async (path: string) => {
        calls.push("rmdir");
        onDisk.delete(path);
      },
    };
    return calls;
  }

  it("falls back to the vault trash when the system trash leaves the note in place", async () => {
    const app = makeApp({ files: { "Note.md": { content: "body" } } });
    const onDisk = new Set(["Note.md"]);
    const calls = withNoOpSystemTrash(app, onDisk);

    const result = await run(getTool(app, "delete"), { path: "Note.md" });

    expect(calls).toEqual(["trashFile", "trashLocal"]);
    expect(onDisk.has("Note.md")).toBe(false);
    expect(unwrapToolOutput(result.text)).toBe("Moved Note.md to trash.");
    expect(result.details).not.toHaveProperty("bypassedTrash");
  });

  it("does not report a delete when the existence check fails", async () => {
    const app = makeApp({ files: { "Note.md": { content: "body" } } });
    withNoOpSystemTrash(app, new Set(["Note.md"]));
    (app.vault.adapter as unknown as { exists: () => Promise<boolean> }).exists = async () => {
      throw new Error("stat failed");
    };

    await expect(run(getTool(app, "delete"), { path: "Note.md" })).rejects.toThrow(/stat failed/);
  });

  it("removes the note and says so when no trash works", async () => {
    const app = makeApp({ files: { "Note.md": { content: "body" } } });
    const onDisk = new Set(["Note.md"]);
    const calls = withNoOpSystemTrash(app, onDisk, { localTrashFails: true });

    const result = await run(getTool(app, "delete"), { path: "Note.md" });

    expect(calls).toEqual(["trashFile", "trashLocal", "remove"]);
    expect(onDisk.has("Note.md")).toBe(false);
    expect(unwrapToolOutput(result.text)).toBe("Deleted Note.md (bypassed trash).");
    expect(result.details).toMatchObject({ bypassedTrash: true });
  });

  it("names every path a recursive delete removed without trash", async () => {
    const app = makeApp({ files: { "Full/A.md": { content: "a" }, "Full/B.md": { content: "b" } } });
    const onDisk = new Set(["Full/A.md", "Full/B.md", "Full"]);
    withNoOpSystemTrash(app, onDisk, { localTrashFails: true });

    const result = await run(getTool(app, "delete"), { path: "Full", recursive: true });

    expect(onDisk.size).toBe(0);
    expect(unwrapToolOutput(result.text)).toBe(
      "Deleted Full. These bypassed the trash and are gone for good: Full/A.md, Full/B.md, Full.",
    );
    expect(result.details).toMatchObject({ bypassedTrash: true, bypassedPaths: ["Full/A.md", "Full/B.md", "Full"] });
  });

  it("refuses to delete a non-empty folder", async () => {
    const app = makeApp({ files: { "Full/Note.md": { content: "body" } } });
    const del = getTool(app, "delete");

    await expect(run(del, { path: "Full" })).rejects.toThrow(/Folder not empty.*recursive:true/);
    expect(app.vault.getAbstractFileByPath("Full")).toBeInstanceOf(TFolder);
    expect(app.vault.getAbstractFileByPath("Full/Note.md")).toBeInstanceOf(TFile);
  });

  it("deletes a non-empty folder with recursive:true", async () => {
    const app = makeApp({ files: { "Full/Note.md": { content: "body" } } });
    const del = getTool(app, "delete");

    const result = await run(del, { path: "Full", recursive: true });

    expect(unwrapToolOutput(result.text)).toBe("Moved Full to trash.");
    expect(result.details).toMatchObject({ path: "Full", kind: "folder", recursive: true });
    expect(app.vault.getAbstractFileByPath("Full")).toBeNull();
    expect(app.vault.getAbstractFileByPath("Full/Note.md")).toBeNull();
  });
});

describe("edit — audit details", () => {
  function editTool(app: App) {
    return createVaultTools(app, undefined).find((t) => t.name === "edit")!;
  }

  it("captures each applied edit's oldText/newText/start/end in result.details", async () => {
    const app = makeApp({ files: { "Note.md": { content: "alpha beta gamma\n" } } });

    const { details } = await run(editTool(app), {
      path: "Note.md",
      edits: [{ oldText: "beta", newText: "BETA" }],
    });

    expect(details).toMatchObject({
      path: "Note.md",
      editCount: 1,
      failedCount: 0,
    });
    const applied = details.applied as Array<Record<string, unknown>>;
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ oldText: "beta", newText: "BETA" });
    expect(typeof applied[0]?.start).toBe("number");
    expect(typeof applied[0]?.end).toBe("number");
    expect(applied[0]?.start).toBe(6);
    expect(applied[0]?.end).toBe(10);
    expect(details.failed).toEqual([]);
  });

  it("captures per-edit failures (and the edit that did apply) in a mixed batch", async () => {
    const app = makeApp({ files: { "Note.md": { content: "alpha beta gamma\n" } } });

    const { text, details } = await run(editTool(app), {
      path: "Note.md",
      edits: [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "delta", newText: "DELTA" },
      ],
    });

    expect(text).toMatch(/Applied 1 of 2/);
    const applied = details.applied as Array<Record<string, unknown>>;
    const failed = details.failed as Array<Record<string, unknown>>;
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ oldText: "alpha", newText: "ALPHA" });
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ oldText: "delta", newText: "DELTA" });
    expect(typeof failed[0]?.error).toBe("string");
    expect(failed[0]?.error).toMatch(/oldText was not found/);
    expect(details.editCount).toBe(1);
    expect(details.failedCount).toBe(1);
  });

  it("captures every failure with no applied edits", async () => {
    const app = makeApp({ files: { "Note.md": { content: "alpha beta gamma\n" } } });

    const { text, details } = await run(editTool(app), {
      path: "Note.md",
      edits: [{ oldText: "delta", newText: "DELTA" }],
    });

    expect(text).toMatch(/Applied 0 of 1/);
    const failed = details.failed as Array<Record<string, unknown>>;
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ oldText: "delta", newText: "DELTA" });
    expect(details.applied).toEqual([]);
    expect(details.editCount).toBe(0);
    expect(details.failedCount).toBe(1);
  });
});
