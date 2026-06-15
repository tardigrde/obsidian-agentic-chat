import { describe, expect, it } from "vitest";
import { buildEditPreview } from "../src/agent/edit-preview";

describe("buildEditPreview", () => {
  it("describes write of a new file", () => {
    const preview = buildEditPreview("write", { path: "n.md", content: "hello" }, null);
    expect(preview).toEqual({ kind: "diff", path: "n.md", before: "", after: "hello", isNew: true });
  });

  it("describes write over an existing file", () => {
    const preview = buildEditPreview("write", { path: "n.md", content: "new" }, "old");
    expect(preview).toMatchObject({ kind: "diff", before: "old", after: "new", isNew: false });
  });

  it("applies edits to produce the after content", () => {
    const preview = buildEditPreview("edit", { path: "n.md", edits: [{ oldText: "a", newText: "A" }] }, "a b");
    expect(preview).toMatchObject({ kind: "diff", before: "a b", after: "A b" });
  });

  it("returns none when an edit's oldText does not match", () => {
    const preview = buildEditPreview("edit", { path: "n.md", edits: [{ oldText: "zzz", newText: "Z" }] }, "a b");
    expect(preview).toEqual({ kind: "none" });
  });

  it("describes delete and rename", () => {
    expect(buildEditPreview("delete", { path: "n.md" }, "body")).toEqual({ kind: "delete", path: "n.md", content: "body" });
    expect(buildEditPreview("rename", { path: "a.md", newPath: "b.md" }, null)).toEqual({ kind: "rename", from: "a.md", to: "b.md" });
  });

  it("returns none for non-previewable tools", () => {
    expect(buildEditPreview("read", { path: "n.md" }, "x")).toEqual({ kind: "none" });
  });
});
