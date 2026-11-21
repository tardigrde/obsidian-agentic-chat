import { describe, expect, it } from "vitest";
import { createPrivateMatcher, noteMetadataFromCache, parsePrivateRules, type NoteMetadata } from "../src/vault/private-rules";

/** U4 #11: the "Ignored paths" setting takes mixed rules. */

describe("parsePrivateRules", () => {
  it("splits on commas and new lines into globs, tags, and properties", () => {
    expect(parsePrivateRules("Private/, *.secret.md\n#Private, #health/x\nprivate=true, draft=, status=*\n# a comment\nprivate")).toEqual({
      // A property-shaped line also stays a literal path glob (no leak for an old `a=b.md` path).
      globs: ["Private/", "*.secret.md", "private=true", "draft=", "status=*", "private"],
      tags: ["private", "health/x"],
      properties: [
        { key: "private", value: "true" },
        { key: "draft", value: null },
        { key: "status", value: null },
      ],
    });
  });
});

describe("createPrivateMatcher", () => {
  const notes: Record<string, NoteMetadata> = {
    "Notes/tagged.md": { tags: ["#private/health"], frontmatter: null },
    "Notes/inline.md": { tags: ["#Private"], frontmatter: null },
    "Notes/prop.md": { tags: [], frontmatter: { Private: true } },
    "Notes/draft.md": { tags: [], frontmatter: { draft: "anything" } },
    "Notes/public.md": { tags: ["#privateer"], frontmatter: { private: false } },
  };
  const matcher = createPrivateMatcher("Secret/, #private, private=true, draft=", ".obsidian", (path) => notes[path] ?? null);

  it("hides by path glob, nested tag, property value, and property key", () => {
    expect(matcher("Secret/plan.md")).toBe(true);
    expect(matcher("Notes/tagged.md")).toBe(true);
    expect(matcher("Notes/inline.md")).toBe(true);
    expect(matcher("Notes/prop.md")).toBe(true);
    expect(matcher("Notes/draft.md")).toBe(true);
  });

  it("does not hide a look-alike tag or another property value; protected folders stay hidden", () => {
    expect(matcher("Notes/public.md")).toBe(false);
    expect(matcher(".obsidian/plugins/x.json")).toBe(true);
  });

  it("reads frontmatter tags and inline tags from the metadata cache", () => {
    expect(noteMetadataFromCache({ tags: [{ tag: "#inline" }], frontmatter: { tags: ["private", "x"], tag: "solo" } })?.tags).toEqual([
      "#inline",
      "private",
      "x",
      "solo",
    ]);
  });
});

describe("a property-shaped line still hides its literal path (U4-B review)", () => {
  it("todo=done.md stays a path glob as well as a property rule", () => {
    const rules = parsePrivateRules("todo=done.md");
    expect(rules.globs).toContain("todo=done.md");
    expect(rules.properties).toEqual([{ key: "todo", value: "done.md" }]);
  });
});
