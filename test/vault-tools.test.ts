import { describe, expect, it } from "vitest";
import { TFile, type App } from "obsidian";
import { createVaultTools, MUTATING_TOOLS } from "../src/tools/vault-tools";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { IgnoreMatcher } from "../src/vault/ignore";
import { ReadMemo } from "../src/vault/read-memo";

interface FileSpec {
  content?: string;
  /** Outbound resolved links (target path -> count). */
  links?: Record<string, number>;
  /** Cached frontmatter as Obsidian's metadataCache would expose it. */
  frontmatter?: Record<string, unknown>;
}

interface VaultSpec {
  files: Record<string, FileSpec>;
  /** Use a Map shape for getBacklinksForFile().data to exercise the defensive path. */
  backlinksAsMap?: boolean;
}

/**
 * Minimal Obsidian `App` stand-in tailored to the graph + frontmatter tools.
 * Builds resolvedLinks/backlinks from the per-file `links` spec.
 */
function makeApp(spec: VaultSpec): App {
  const files = new Map<string, TFile>();
  const contents = new Map<string, string>();
  const frontmatterCache = new Map<string, Record<string, unknown>>();

  for (const [path, file] of Object.entries(spec.files)) {
    const tfile = new TFile();
    tfile.path = path;
    tfile.name = path.split("/").pop() ?? path;
    tfile.extension = tfile.name.includes(".") ? tfile.name.split(".").pop() ?? "" : "";
    // The read tool guards on file size; surface it so the guardrail is testable.
    (tfile as unknown as { stat: { size: number } }).stat = { size: file.content?.length ?? 0 };
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
      cachedRead: async (file: TFile) => contents.get(file.path) ?? "",
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
      trashFile: async () => {},
    },
  } as unknown as App;
}

function getTool(app: App, name: string, isIgnored?: IgnoreMatcher): AgentTool {
  const tool = createVaultTools(app, isIgnored).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
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

describe("MUTATING_TOOLS", () => {
  it("includes set_properties but not the read-only graph/property tools", () => {
    expect(MUTATING_TOOLS.has("set_properties")).toBe(true);
    expect(MUTATING_TOOLS.has("get_properties")).toBe(false);
    expect(MUTATING_TOOLS.has("get_backlinks")).toBe(false);
    expect(MUTATING_TOOLS.has("get_links")).toBe(false);
    expect(MUTATING_TOOLS.has("local_graph")).toBe(false);
  });
});

describe("get_backlinks", () => {
  const spec: VaultSpec = {
    files: {
      "Target.md": {},
      "A.md": { links: { "Target.md": 2 } },
      "B.md": { links: { "Target.md": 1, "A.md": 1 } },
      "Unrelated.md": {},
    },
  };

  it("lists notes that link to the target with ref counts", async () => {
    const app = makeApp(spec);
    const { text, details } = await run(getTool(app, "get_backlinks"), { path: "Target.md" });
    expect(details.sources).toEqual(["A.md", "B.md"]);
    expect(text).toContain("A.md\t2 refs");
    expect(text).toContain("B.md\t1 ref");
  });

  it("handles a Map-shaped backlink result defensively", async () => {
    const app = makeApp({ ...spec, backlinksAsMap: true });
    const { details } = await run(getTool(app, "get_backlinks"), { path: "Target.md" });
    expect(details.sources).toEqual(["A.md", "B.md"]);
  });

  it("hides ignored source notes", async () => {
    const app = makeApp(spec);
    const { text, details } = await run(getTool(app, "get_backlinks", ignore("A.md")), { path: "Target.md" });
    expect(details.sources).toEqual(["B.md"]);
    expect(text).not.toContain("A.md");
  });

  it("reports an ignored target as not found", async () => {
    const app = makeApp(spec);
    await expect(run(getTool(app, "get_backlinks", ignore("Target.md")), { path: "Target.md" })).rejects.toThrow(
      /not found/,
    );
  });

  it("reports a missing target as not found", async () => {
    const app = makeApp(spec);
    await expect(run(getTool(app, "get_backlinks"), { path: "Nope.md" })).rejects.toThrow(/not found/);
  });

  it("reports no backlinks cleanly", async () => {
    const app = makeApp(spec);
    const { text, details } = await run(getTool(app, "get_backlinks"), { path: "Unrelated.md" });
    expect(text).toBe("No backlinks.");
    expect(details.count).toBe(0);
  });
});

describe("get_links", () => {
  const spec: VaultSpec = {
    files: {
      "Source.md": { links: { "X.md": 1, "Y.md": 3 } },
      "X.md": {},
      "Y.md": {},
    },
  };

  it("lists outbound resolved links with counts", async () => {
    const app = makeApp(spec);
    const { text, details } = await run(getTool(app, "get_links"), { path: "Source.md" });
    expect(details.targets).toEqual(["X.md", "Y.md"]);
    expect(text).toContain("X.md\t1 link");
    expect(text).toContain("Y.md\t3 links");
  });

  it("hides ignored target notes", async () => {
    const app = makeApp(spec);
    const { details } = await run(getTool(app, "get_links", ignore("X.md")), { path: "Source.md" });
    expect(details.targets).toEqual(["Y.md"]);
  });

  it("reports an ignored source as not found", async () => {
    const app = makeApp(spec);
    await expect(run(getTool(app, "get_links", ignore("Source.md")), { path: "Source.md" })).rejects.toThrow(
      /not found/,
    );
  });

  it("reports a missing source as not found", async () => {
    const app = makeApp(spec);
    await expect(run(getTool(app, "get_links"), { path: "Ghost.md" })).rejects.toThrow(/not found/);
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

  it("reports an ignored note as not found", async () => {
    const app = makeApp(spec);
    await expect(run(getTool(app, "local_graph", ignore("Hub.md")), { path: "Hub.md" })).rejects.toThrow(
      /not found/,
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
    expect(JSON.parse(text)).toEqual({ status: "active", tags: ["a", "b"] });
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
    expect(JSON.parse(text)).toEqual({ status: "draft" });
  });

  it("reports no frontmatter cleanly", async () => {
    const app = makeApp({ files: { "Note.md": { content: "Just a body" } } });
    const { text, details } = await run(getTool(app, "get_properties"), { path: "Note.md" });
    expect(text).toBe("(no frontmatter properties)");
    expect(details.keys).toEqual([]);
  });

  it("reports an ignored note as not found", async () => {
    const app = makeApp({ files: { "Note.md": { frontmatter: { a: 1 } } } });
    await expect(run(getTool(app, "get_properties", ignore("Note.md")), { path: "Note.md" })).rejects.toThrow(
      /not found/,
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
    expect(JSON.parse(after.text)).toEqual({ status: "published", keep: "me", priority: 3 });
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
    expect(JSON.parse(after.text)).toEqual({ keep: "y" });
  });

  it("creates frontmatter on a note that has none", async () => {
    const app = makeApp({ files: { "Note.md": { content: "Body only" } } });
    await run(getTool(app, "set_properties"), { path: "Note.md", properties: { tag: "new" } });
    const after = await run(getTool(app, "get_properties"), { path: "Note.md" });
    expect(JSON.parse(after.text)).toEqual({ tag: "new" });
  });

  it("reports an ignored note as not found and does not mutate it", async () => {
    const app = makeApp({ files: { "Note.md": { frontmatter: { a: 1 } } } });
    await expect(
      run(getTool(app, "set_properties", ignore("Note.md")), { path: "Note.md", properties: { a: 2 } }),
    ).rejects.toThrow(/not found/);
    const after = await run(getTool(app, "get_properties"), { path: "Note.md" });
    expect(JSON.parse(after.text)).toEqual({ a: 1 });
  });

  it("reports a missing note as not found", async () => {
    const app = makeApp({ files: {} });
    await expect(
      run(getTool(app, "set_properties"), { path: "Gone.md", properties: { a: 1 } }),
    ).rejects.toThrow(/not found/);
  });
});

describe("read — dedup + size guardrail", () => {
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

  it("treats a different range as a fresh read (pagination is not deduped)", async () => {
    const app = makeApp({ files: { "Note.md": { content: "line1\nline2" } } });
    const memo = new ReadMemo();
    const read = createVaultTools(app, undefined, memo).find((t) => t.name === "read")!;
    await run(read, { path: "Note.md" });
    const ranged = await run(read, { path: "Note.md", offset: 1, limit: 1 });
    expect(ranged.details.deduplicated).toBeFalsy();
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
