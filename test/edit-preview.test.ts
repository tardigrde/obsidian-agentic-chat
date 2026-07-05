import { describe, expect, it } from "vitest";
import { buildEditPreview, buildExactEditPreviewWindow } from "../src/agent/edit-preview";

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

  it("returns none for malformed edits args (not an array / wrong shape)", () => {
    expect(buildEditPreview("edit", { path: "n.md", edits: "oops" }, "a b")).toEqual({ kind: "none" });
    expect(buildEditPreview("edit", { path: "n.md", edits: null }, "a b")).toEqual({ kind: "none" });
    expect(buildEditPreview("edit", { path: "n.md", edits: [{ oldText: 1 }] }, "a b")).toEqual({ kind: "none" });
  });

  it("describes delete and rename", () => {
    expect(buildEditPreview("delete", { path: "n.md" }, "body")).toEqual({ kind: "delete", path: "n.md", content: "body" });
    expect(buildEditPreview("rename", { path: "a.md", newPath: "b.md" }, null)).toEqual({ kind: "rename", from: "a.md", to: "b.md" });
  });

  it("returns none for non-previewable tools", () => {
    expect(buildEditPreview("read", { path: "n.md" }, "x")).toEqual({ kind: "none" });
  });
});

describe("buildExactEditPreviewWindow", () => {
  it("includes ten real file lines below a middle one-line edit", () => {
    const content = Array.from({ length: 41 }, (_, index) => `line ${index + 1}`).join("\n");
    const windowed = buildExactEditPreviewWindow(content, [{ oldText: "line 21", newText: "line twenty-one" }]);

    expect(windowed).not.toBeNull();
    expect(windowed?.hiddenBefore).toBe(10);
    expect(windowed?.hiddenAfter).toBe(10);
    const beforeLines = windowed?.before.split("\n").filter((line) => line.length > 0);
    expect(beforeLines?.[0]).toBe("line 11");
    expect(beforeLines?.at(-1)).toBe("line 31");
    expect(windowed?.after).toContain("line twenty-one");
    expect(windowed?.after).toContain("line 31");
  });
});
