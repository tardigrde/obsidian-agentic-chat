import { describe, expect, it } from "vitest";
import { TFile, type App } from "obsidian";
import { createVaultTools, MUTATING_TOOLS } from "../src/tools/vault-tools";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { IgnoreMatcher } from "../src/vault/ignore";

interface FileSpec {
  content?: string;
  /** Outbound resolved links (target path -> count). */
  links?: Record<string, number>;
}

interface VaultSpec {
  files: Record<string, FileSpec>;
  /** Use a Map shape for getBacklinksForFile().data to exercise the defensive path. */
  backlinksAsMap?: boolean;
}

/**
 * Minimal Obsidian `App` stand-in tailored to the graph tools.
 * Builds resolvedLinks/backlinks from the per-file `links` spec.
 */
function makeApp(spec: VaultSpec): App {
  const files = new Map<string, TFile>();
  const contents = new Map<string, string>();

  for (const [path, file] of Object.entries(spec.files)) {
    const tfile = new TFile();
    tfile.path = path;
    tfile.name = path.split("/").pop() ?? path;
    tfile.extension = tfile.name.includes(".") ? tfile.name.split(".").pop() ?? "" : "";
    files.set(path, tfile);
    contents.set(path, file.content ?? "");
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
  it("keeps the read-only graph tools out of the mutating set", () => {
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
