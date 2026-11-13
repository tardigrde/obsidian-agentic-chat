import { describe, expect, it } from "vitest";
import { parseFrontmatterFields, splitFrontmatter } from "../src/vault/frontmatter";

describe("shared frontmatter table", () => {
  it("matches the source-artifact fields parser", () => {
    const fields = parseFrontmatterFields('---\nname: "a\\nb"\ntags: [x, y]\n---\nbody');

    expect(fields?.get("name")).toBe("a\nb");
    expect(fields?.get("tags")).toBe("[x, y]");
    expect(parseFrontmatterFields("---\r\nname: x\r\n---\r\nbody")).toBeNull();
  });

  it("matches the relevant-notes simple parser", () => {
    const result = splitFrontmatter(
      "---\r\nname: 'quoted'\r\ntags: [a, b]\r\nbad key: no\r\n---\r\n\r\nbody",
      { flavor: "simple", normalizeNewlines: true, body: "drop-one-newline" },
    );

    expect(result.data).toEqual({ name: "quoted", tags: ["a", "b"] });
    expect(result.body).toBe("\nbody");
  });

  it("matches the skills YAML parser", () => {
    const result = splitFrontmatter("---\nname: skill\n---\n\n\nBody", {
      flavor: "yaml",
      body: "trimStart",
      objectOnly: false,
    });

    expect(result.data).toMatchObject({ name: "skill" });
    expect(result.body).toBe("Body");

    const invalid = splitFrontmatter("---\n\tname: broken\n---\nBody", {
      flavor: "yaml",
      body: "trimStart",
    });
    expect(invalid.data).toEqual({});
    expect(invalid.parseProblem).toMatch(/not valid YAML/);
    expect(invalid.body).toBe("Body");
  });

  it("matches the vault-tools YAML parser", () => {
    expect(splitFrontmatter("---\nname: note\n---\nbody", { flavor: "yaml", objectOnly: true }).data).toEqual({
      name: "note",
    });
    expect(splitFrontmatter("---\n---\nbody", { flavor: "yaml", objectOnly: true }).data).toEqual({});
    expect(splitFrontmatter("---\nscalar\n---", { flavor: "yaml", objectOnly: true }).data).toEqual({});
    expect(() =>
      splitFrontmatter("---\n\tbroken: yes\n---", { flavor: "yaml", reportParseProblem: false }),
    ).toThrow();
  });
});
