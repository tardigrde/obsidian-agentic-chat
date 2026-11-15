import { describe, expect, it } from "vitest";
import { generateVault, type GeneratedVault, type VaultSize } from "../scripts/eval/vault-generator";

const SIZES: VaultSize[] = ["S", "M"];

function notePaths(vault: GeneratedVault): string[] {
  return Object.keys(vault.files).filter((filePath) => filePath.endsWith(".md"));
}

function basename(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1, -".md".length);
}

function contentOf(vault: GeneratedVault, path: string): string {
  const content = vault.files[path];
  if (content === undefined) throw new Error(`missing generated file: ${path}`);
  return content;
}

describe("seeded vault generator", () => {
  it("generates exactly 50 S notes and 500 M notes", () => {
    expect(notePaths(generateVault("S", 1))).toHaveLength(50);
    expect(notePaths(generateVault("M", 1))).toHaveLength(500);
  });

  it("adds non-Markdown fixtures without changing the note count", () => {
    const vault = generateVault("S", 2);
    const fixtures = Object.keys(vault.files).filter((filePath) => !filePath.endsWith(".md"));

    expect(fixtures.length).toBeGreaterThan(0);
    expect(fixtures.every((filePath) => filePath.endsWith(".csv") || filePath.endsWith(".txt"))).toBe(true);
    expect(notePaths(vault)).toHaveLength(50);
  });

  it("repeats a seed byte for byte and changes with the seed", () => {
    for (const size of SIZES) {
      const first = generateVault(size, 42);
      const second = generateVault(size, 42);

      expect(Object.keys(first.files)).toEqual(Object.keys(second.files));
      expect(first.files).toEqual(second.files);
      expect(JSON.stringify(first.files)).toBe(JSON.stringify(second.files));
      expect(first.files).not.toEqual(generateVault(size, 43).files);
    }
  });

  it("keeps every path vault-relative, unique, NFC, and out of .obsidian", () => {
    for (const size of SIZES) {
      const paths = Object.keys(generateVault(size, 5).files);
      expect(new Set(paths).size).toBe(paths.length);

      for (const filePath of paths) {
        const segments = filePath.split("/");
        expect(filePath.startsWith("/")).toBe(false);
        expect(filePath).not.toContain("\\");
        expect(segments).not.toContain("..");
        expect(segments).not.toContain(".obsidian");
        expect(filePath.startsWith(".")).toBe(false);
        expect(filePath).toBe(filePath.normalize("NFC"));
      }
    }
  });

  it("keeps 25-30% of the notes Hungarian, with accented paths and frontmatter", () => {
    for (const size of ["M", "L"] as VaultSize[]) {
      const vault = generateVault(size, 9);
      const notes = notePaths(vault);
      const accented = Object.keys(vault.files).filter((filePath) => /[^\x20-\x7E]/.test(filePath));

      expect(accented.length).toBeGreaterThan(0);
      for (const path of accented) expect(path).toBe(path.normalize("NFC"));

      const accentedTitles = Object.values(vault.files).filter((content) => /^title: ".*[^\x20-\x7E]/m.test(content));
      expect(accentedTitles.length).toBeGreaterThan(0);

      const hungarian = notes.filter((path) => contentOf(vault, path).includes("## Összefoglaló"));
      expect(hungarian.length / notes.length, size).toBeGreaterThanOrEqual(0.25);
      expect(hungarian.length / notes.length, size).toBeLessThanOrEqual(0.3);
    }
  });

  it("keeps near-duplicate copies in the archive with older facts", () => {
    const vault = generateVault("S", 3);
    const notes = notePaths(vault);
    const archived = notes.filter((path) => path.startsWith("900 Archive/"));
    const liveBasenames = new Set(notes.filter((path) => !path.startsWith("900 Archive/")).map(basename));

    expect(archived.length).toBeGreaterThan(0);
    const twin = archived.find((path) => liveBasenames.has(basename(path)));
    if (!twin) throw new Error("no archive copy shares a basename with a live note");

    const live = notes.find((path) => !path.startsWith("900 Archive/") && basename(path) === basename(twin));
    if (!live) throw new Error("missing live twin");

    expect(contentOf(vault, twin)).toContain("status: archived");
    expect(contentOf(vault, twin)).not.toBe(contentOf(vault, live));
  });

  it("seeds daily notes, templates, embeds, block refs, and frontmatter", () => {
    const vault = generateVault("M", 7);
    const notes = notePaths(vault);
    const dailies = notes.filter((path) => /^500 Journal\/\d{4}\/\d{4}-\d{2}-\d{2}\.md$/.test(path));
    const contents = notes.map((path) => contentOf(vault, path));

    expect(dailies.length).toBeGreaterThan(0);
    expect(notes.filter((path) => path.startsWith("800 Templates/")).length).toBeGreaterThan(0);
    expect(contents.filter((content) => content.includes("![[")).length).toBeGreaterThan(0);
    expect(contents.filter((content) => /\^blk-[a-z0-9]+-\d/m.test(content)).length).toBeGreaterThan(0);
    expect(contents.filter((content) => content.includes("\n## ")).length).toBe(notes.length);

    for (const key of ["title:", "tags:", "aliases:", "created:"]) {
      expect(contents[0]).toContain(key);
    }
  });

  it("includes a few long notes", () => {
    const contents = Object.values(generateVault("M", 4).files);

    expect(contents.filter((content) => content.split("\n").length >= 100).length).toBeGreaterThan(0);
  });

  it("generates M well inside the CI ceiling", () => {
    const started = performance.now();
    generateVault("M", 123);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("seeded L vault", () => {
  it("generates exactly 2,000 L notes", () => {
    expect(notePaths(generateVault("L", 1))).toHaveLength(2_000);
  });

  it("repeats an L seed byte for byte and changes with the seed", () => {
    const first = generateVault("L", 42);
    const second = generateVault("L", 42);

    expect(JSON.stringify(first.files)).toBe(JSON.stringify(second.files));
    expect(first.files).not.toEqual(generateVault("L", 43).files);
  });

  it("keeps every L path and every L basename unique and clean", () => {
    const paths = Object.keys(generateVault("L", 5).files);
    const notes = notePaths(generateVault("L", 5));
    const basenames = notes.map(basename);

    expect(notes).toHaveLength(2_000);
    expect(new Set(paths).size, "duplicate path").toBe(paths.length);
    expect(new Set(basenames).size, "duplicate basename").toBe(basenames.length);

    for (const filePath of paths) {
      const segments = filePath.split("/");
      expect(filePath.startsWith("/")).toBe(false);
      expect(filePath).not.toContain("\\");
      expect(segments).not.toContain("..");
      expect(segments).not.toContain(".obsidian");
      expect(filePath.startsWith(".")).toBe(false);
      expect(filePath).toBe(filePath.normalize("NFC"));
    }
  });

  it("keeps accented NFC names and non-ASCII frontmatter at L", () => {
    const vault = generateVault("L", 9);
    const accented = Object.keys(vault.files).filter((filePath) => /[^\x20-\x7E]/.test(filePath));

    expect(accented.length).toBeGreaterThan(0);
    for (const filePath of accented) expect(filePath).toBe(filePath.normalize("NFC"));

    const accentedTitles = Object.values(vault.files).filter((content) => /^title: ".*[^\x20-\x7E]/m.test(content));
    expect(accentedTitles.length).toBeGreaterThan(0);
  });

  it("keeps the L shape: dailies, templates, archive copies, embeds, and block refs", () => {
    const vault = generateVault("L", 6);
    const notes = notePaths(vault);
    const contents = notes.map((path) => contentOf(vault, path));
    const dailies = notes.filter((path) => /^500 Journal\/\d{4}\/\d{4}-\d{2}-\d{2}(?: \d+)?\.md$/.test(path));
    const archived = notes.filter((path) => path.startsWith("900 Archive/"));

    expect(dailies.length).toBeGreaterThan(100);
    expect(notes.filter((path) => path.startsWith("800 Templates/")).length).toBeGreaterThan(0);
    expect(archived.length).toBeGreaterThan(100);
    expect(contents.filter((content) => content.includes("![[")).length).toBeGreaterThan(0);
    expect(contents.filter((content) => /\^blk-[a-z0-9]+-\d/m.test(content)).length).toBeGreaterThan(0);
    expect(contents.filter((content) => content.split("\n").length >= 100).length).toBeGreaterThan(0);

    for (const path of archived) {
      const content = contentOf(vault, path);
      const source = content.match(/\[\[([^|\]]+)\|/);
      if (!source) throw new Error(`archive copy without a live source: ${path}`);

      expect(content).toContain("status: archived");
      expect(source[1].startsWith("900 Archive/")).toBe(false);
      expect(vault.files[`${source[1]}.md`], `dangling live source in ${path}`).toBeDefined();
      expect(content).not.toBe(contentOf(vault, `${source[1]}.md`));
    }
  });

  it("generates L well inside the CI ceiling", () => {
    const started = performance.now();
    generateVault("L", 123);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
