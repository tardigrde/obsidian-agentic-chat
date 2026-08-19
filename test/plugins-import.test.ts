import { describe, expect, it } from "vitest";
import { gzipSync, zipSync } from "../src/vendor/fflate";
import { extractArchive, extractTarGz, safeArchivePath, ARCHIVE_LIMITS } from "../src/plugins/import/archive";
import {
  parseImportSource,
  resolveImportSource,
  type ImportBytesFetcher,
} from "../src/plugins/import/url-source";
import { sniffSource } from "../src/plugins/import/sniff";
import { sanitizeSkillDoc } from "../src/plugins/import/convert";

const ENCODER = new TextEncoder();

/** Build a minimal tar.gz fixture from {path: content} entries (ustar, octal sizes). */
function makeTarGz(files: Record<string, string>): Uint8Array {
  const blocks: number[][] = [];
  const encoder = new TextEncoder();
  for (const [name, content] of Object.entries(files)) {
    const body = encoder.encode(content);
    const header = new Uint8Array(512);
    writeAscii(header, 0, name.slice(0, 100));
    writeAscii(header, 100, "0000644\0");
    writeAscii(header, 108, "0000000\0");
    writeAscii(header, 116, "0000000\0");
    writeAscii(header, 124, octal(body.length, 11) + "\0");
    writeAscii(header, 136, "00000000000\0");
    writeAscii(header, 148, "00000000000\0");
    header[156] = 0x30;
    writeAscii(header, 257, "ustar\0" + "00");
    blocks.push([...header]);
    const padded = Math.ceil(body.length / 512) * 512;
    const data = new Uint8Array(padded);
    data.set(body);
    blocks.push([...data]);
  }
  blocks.push(new Array(512).fill(0), new Array(512).fill(0));
  return new Uint8Array(blocks.flat());
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i += 1) target[offset + i] = value.charCodeAt(i);
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length, "0");
}

/** Minimal valid tar header generation is covered above; gzip wrap for .tar.gz. */
function gzipWrap(data: Uint8Array): Uint8Array {
  return gzipSync(data);
}

describe("archive extraction", () => {
  it("extracts ustar tar archives with safe relative paths", () => {
    const tree = extractTarGz(gzipWrap(makeTarGz({ "pkg/SKILL.md": "# hello", "pkg/scripts/run.sh": "echo hi" })));
    expect([...tree.keys()].sort()).toEqual(["pkg/SKILL.md", "pkg/scripts/run.sh"]);
    expect(new TextDecoder().decode(tree.get("pkg/SKILL.md"))).toBe("# hello");
  });

  it("extracts zip archives", () => {
    const bytes = zipSync({ "pkg/SKILL.md": ENCODER.encode("# hi"), "pkg/a/b.txt": ENCODER.encode("deep") });
    const tree = extractArchive(bytes, "zip");
    expect([...tree.keys()].sort()).toEqual(["pkg/SKILL.md", "pkg/a/b.txt"]);
  });

  it("drops directory entries and normalizes windows separators", () => {
    const bytes = zipSync({
      "pkg\\SKILL.md": ENCODER.encode("# hi"),
      "pkg/": ENCODER.encode(""),
    });
    const tree = extractArchive(bytes, "zip");
    expect([...tree.keys()]).toEqual(["pkg/SKILL.md"]);
  });

  it("rejects traversal and absolute paths", () => {
    expect(safeArchivePath("../escape.md")).toBeNull();
    expect(safeArchivePath("/abs.md")).toBeNull();
    expect(safeArchivePath("C:/evil.md")).toBeNull();
    expect(safeArchivePath("a/../b.md")).toBeNull();
    expect(safeArchivePath("dir/")).toBeNull();
    expect(safeArchivePath("ok/file.md")).toBe("ok/file.md");
  });

  it("rejects trailing .., dot/space segments, and Windows reserved names", () => {
    expect(safeArchivePath("a/b/..")).toBeNull();
    expect(safeArchivePath("a//..")).toBeNull();
    expect(safeArchivePath("a/./b.md")).toBeNull();
    expect(safeArchivePath("a/b./c.md")).toBeNull();
    expect(safeArchivePath("a/b /c.md")).toBeNull();
    expect(safeArchivePath("CON")).toBeNull();
    expect(safeArchivePath("skills/NUL/SKILL.md")).toBeNull();
    expect(safeArchivePath("a/COM1.txt")).toBeNull();
    expect(safeArchivePath("a/lpt9.bin")).toBeNull();
    expect(safeArchivePath("ok/file.md")).toBe("ok/file.md");
  });

  it("skips an oversized entry instead of aborting the rest of the tar", { timeout: 30_000 }, () => {
    // A single entry larger than the per-file cap that appears before
    // plugin.json must be skipped, not fatal (codeload tarballs sort entries).
    const big = new Uint8Array(ARCHIVE_LIMITS.singleFileBytes + 1024);
    big.fill(0x61);
    const tar = makeTarGzDirect([
      { name: "assets/huge.bin", content: big },
      { name: "pkg/plugin.json", content: ENCODER.encode("{}") },
    ]);
    const tree = extractTarGz(gzipWrap(tar));
    expect(tree.has("assets/huge.bin")).toBe(false);
    expect(new TextDecoder().decode(tree.get("pkg/plugin.json"))).toBe("{}");
  });
});

/** Direct tar builder that supports binary entries without nested-array blowup. */
function makeTarGzDirect(entries: Array<{ name: string; content: Uint8Array }>): Uint8Array {
  const total =
    entries.reduce((sum, entry) => sum + 512 + Math.ceil(entry.content.length / 512) * 512, 0) + 1024;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const { name, content } of entries) {
    const header = new Uint8Array(512);
    writeAscii(header, 0, name.slice(0, 100));
    writeAscii(header, 100, "0000644\0");
    writeAscii(header, 108, "0000000\0");
    writeAscii(header, 116, "0000000\0");
    writeAscii(header, 124, octal(content.length, 11) + "\0");
    writeAscii(header, 136, "00000000000\0");
    writeAscii(header, 148, "00000000000\0");
    header[156] = 0x30;
    writeAscii(header, 257, "ustar\0" + "00");
    out.set(header, offset);
    offset += 512;
    out.set(content, offset);
    offset += Math.ceil(content.length / 512) * 512;
  }
  return out;
}

describe("parseImportSource", () => {
  it("accepts owner/repo shorthand", () => {
    expect(parseImportSource("tardigrde/obsidian-agentic-chat")).toEqual({
      parsed: { kind: "github", owner: "tardigrde", repo: "obsidian-agentic-chat" },
    });
  });

  it("accepts github.com repo, tree, blob, and raw URLs", () => {
    expect(parseImportSource("https://github.com/a/b")).toMatchObject({ parsed: { kind: "github", owner: "a", repo: "b" } });
    expect(parseImportSource("https://github.com/a/b/tree/main/skills")).toMatchObject({
      parsed: { kind: "github", owner: "a", repo: "b", ref: "main", path: "skills" },
    });
    expect(parseImportSource("https://github.com/a/b/blob/main/skills/x/SKILL.md")).toMatchObject({
      parsed: { kind: "github", owner: "a", repo: "b", ref: "main", path: "skills/x/SKILL.md" },
    });
    expect(parseImportSource("https://raw.githubusercontent.com/a/b/main/skills/x/SKILL.md")).toMatchObject({
      parsed: { kind: "github", owner: "a", repo: "b", ref: "main", path: "skills/x/SKILL.md" },
    });
  });

  it("accepts archive URLs with kind hints", () => {
    expect(parseImportSource("https://github.com/a/b/archive/refs/tags/v1.0.zip")).toMatchObject({
      parsed: { kind: "archive-url", kindHint: "zip" },
    });
    expect(parseImportSource("https://codeload.github.com/a/b/tar.gz/main")).toMatchObject({
      parsed: { kind: "archive-url", kindHint: "tar.gz" },
    });
    expect(parseImportSource("https://example.com/x.tgz")).toMatchObject({ parsed: { kind: "archive-url", kindHint: "tar.gz" } });
  });

  it("rejects unsupported shapes with explicit messages", () => {
    expect("error" in parseImportSource("https://example.com/page.html")).toBe(true);
    expect("error" in parseImportSource("not a url")).toBe(true);
    expect("error" in parseImportSource("https://github.com/a/b/issues/1")).toBe(true);
    expect("error" in parseImportSource("")).toBe(true);
  });

  it("keeps the full remainder for tree/blob URLs with slash-containing refs", () => {
    expect(parseImportSource("https://github.com/a/b/tree/feature/foo/skills")).toMatchObject({
      parsed: { kind: "github", owner: "a", repo: "b", ref: "feature", path: "foo/skills", remainder: "feature/foo/skills" },
    });
    expect(parseImportSource("https://github.com/a/b/blob/release/1.2/skills/x/SKILL.md")).toMatchObject({
      parsed: { kind: "github", owner: "a", repo: "b", ref: "release", path: "1.2/skills/x/SKILL.md", remainder: "release/1.2/skills/x/SKILL.md" },
    });
  });

  it("accepts GitHub release-asset archive URLs", () => {
    expect(parseImportSource("https://github.com/a/b/releases/download/v1.0/pkg.zip")).toMatchObject({
      parsed: { kind: "archive-url", kindHint: "zip" },
    });
  });

  it("resolves tree refs with slashes longest-ref-first", async () => {
    const repoTar = gzipWrap(makeTarGz({ "repo-sha/foo/skills/a.md": "# A", "repo-sha/README.md": "# R" }));
    const fetcher: ImportBytesFetcher = {
      fetchBytes: async (url) => {
        if (url.includes("/tar.gz/feature/foo/skills")) return { status: 404, bytes: undefined, contentType: undefined };
        if (url.includes("/tar.gz/feature/foo")) return { status: 404, bytes: undefined, contentType: undefined };
        if (url.includes("/tar.gz/feature")) return { status: 200, bytes: repoTar, contentType: "application/gzip" };
        return { status: 404, bytes: undefined, contentType: undefined };
      },
    };
    const resolved = await resolveImportSource(
      { kind: "github", owner: "a", repo: "b", ref: "feature", path: "foo/skills", remainder: "feature/foo/skills", mode: "tree" },
      fetcher,
    );
    expect([...resolved.tree.keys()].sort()).toEqual(["a.md"]);
  });

  it("falls back through refs and throws a clear error when none exist", async () => {
    const fetcher: ImportBytesFetcher = {
      fetchBytes: async () => ({ status: 404, bytes: undefined, contentType: undefined }),
    };
    await expect(
      resolveImportSource(
        { kind: "github", owner: "a", repo: "b", ref: "missing", remainder: "missing/x", mode: "tree" },
        fetcher,
      ),
    ).rejects.toThrow(/Could not download a snapshot/);
  });
});

function treeOf(files: Record<string, string>) {
  return new Map(Object.entries(files).map(([path, text]) => [path, ENCODER.encode(text)]));
}

describe("sniffSource", () => {
  it("detects a native Agent Plugins package at the root", () => {
    const result = sniffSource(
      treeOf({
        "plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "x" }),
        "skills/x/SKILL.md": "---\nname: x\n---",
      }),
    );
    expect(result.kind).toBe("package");
    if (result.kind === "package") {
      expect(result.candidates[0]).toMatchObject({ root: "", isAgentPlugins: true, name: "x" });
    }
  });

  it("detects .claude-plugin, .codex-plugin, and .plugin layouts", () => {
    const claude = sniffSource(
      treeOf({ ".claude-plugin/plugin.json": JSON.stringify({ name: "c" }), "skills/c/SKILL.md": "# c" }),
    );
    expect(claude.kind).toBe("package");
    if (claude.kind === "package") expect(claude.candidates[0]).toMatchObject({ format: "claude" });
    const codex = sniffSource(
      treeOf({ ".codex-plugin/plugin.json": JSON.stringify({ name: "d" }), "skills/d/SKILL.md": "# d" }),
    );
    expect(codex.kind).toBe("package");
    if (codex.kind === "package") expect(codex.candidates[0]).toMatchObject({ format: "codex" });
  });

  it("finds packages at depth <= 2", () => {
    const result = sniffSource(
      treeOf({
        "plugins/my-tool/plugin.json": JSON.stringify({ name: "my-tool" }),
        "plugins/my-tool/skills/my-tool/SKILL.md": "# t",
      }),
    );
    expect(result.kind).toBe("package");
    if (result.kind === "package") {
      expect(result.candidates.map((c) => c.root)).toContain("plugins/my-tool");
    }
  });

  it("detects marketplace catalogs and resolves ./ sources", () => {
    const result = sniffSource(
      treeOf({
        "marketplace.json": JSON.stringify({
          name: "demo",
          sources: [{ name: "a", source: "./plugins/a" }, { name: "b", source: "https://x/y.zip" }],
        }),
        "plugins/a/plugin.json": JSON.stringify({ name: "a" }),
      }),
    );
    expect(result.kind).toBe("marketplace");
    if (result.kind === "marketplace") {
      expect(result.sources).toContainEqual({ kind: "local", name: "a", folder: "plugins/a" });
      expect(result.sources).toContainEqual({ kind: "remote", name: "b", source: "https://x/y.zip" });
    }
  });

  it("accepts a bare root SKILL.md and reports nothing useful otherwise", () => {
    const bare = sniffSource(treeOf({ "SKILL.md": "---\nname: solo\n---" }));
    expect(bare.kind).toBe("package");
    if (bare.kind === "package") expect(bare.candidates[0].root).toBe("");
    const nothing = sniffSource(treeOf({ "readme.txt": "hi" }));
    expect(nothing.kind).toBe("nothing");
  });
});

describe("sanitizeSkillDoc", () => {
  it("keeps only the six Agent Skills fields and forces name to the directory", () => {
    const doc = `---
name: other-name
description: A skill
metadata: v1
displayName: X
license: MIT
allowed-tools:
  - read
compatibility: obsidian
unknown: keep? no
---
Body text
`;
    const warnings: string[] = [];
    const out = sanitizeSkillDoc(doc, "real-name", warnings);
    expect(out).toContain("name: \"real-name\"");
    expect(out).toContain("description: \"A skill\"");
    expect(out).toContain("metadata: \"v1\"");
    expect(out).not.toContain("displayName");
    expect(out).not.toContain("unknown:");
    expect(out).not.toContain("other-name");
    expect(out).toContain("Body text");
    expect(warnings.some((w) => w.includes("renamed to the directory name"))).toBe(true);
  });

  it("synthesizes a frontmatter block for documents without one", () => {
    const warnings: string[] = [];
    const out = sanitizeSkillDoc("# No frontmatter\n", "plain", warnings);
    expect(out.startsWith("---\nname: plain\n")).toBe(true);
  });
});
