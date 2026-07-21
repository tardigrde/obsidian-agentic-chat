import { describe, expect, it } from "vitest";
import { markdownToRetrievalDocument } from "../src/retrieval/relevant-notes";
import type { RetrievalDocument } from "../src/retrieval/policy";

function doc(path: string, content: string): RetrievalDocument {
  return markdownToRetrievalDocument({
    id: path,
    path,
    basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path,
    content,
  });
}

describe("markdownToRetrievalDocument", () => {
  it("extracts headings, tags, aliases, frontmatter, and wiki links", () => {
    const parsed = doc(
      "Projects/Alpha.md",
      [
        "---",
        "tags: [project, alpha]",
        "aliases: [launch note, alpha hub]",
        "lang: en",
        "---",
        "# Alpha Plan",
        "See [[Notes/Research.md#Sources]] and #status/open.",
      ].join("\n"),
    );

    expect(parsed).toMatchObject({
      title: "Alpha Plan",
      tags: ["project", "alpha", "status/open"],
      aliases: ["launch note", "alpha hub"],
      links: ["Notes/Research.md"],
      language: "en",
    });
  });
});
