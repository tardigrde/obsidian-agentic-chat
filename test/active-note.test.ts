import { describe, expect, it } from "vitest";
import {
  autoActiveNotePath,
  buildActiveNotePointer,
  effectiveActiveNote,
  MAX_OPEN_NOTES,
  MAX_POINTER_SELECTION_CHARS,
  privateActiveNotePath,
} from "../src/ui/active-note";

describe("effectiveActiveNote", () => {
  it("points at the active note by default", () => {
    expect(effectiveActiveNote({ activePath: "Notes/A.md", explicit: [] })).toBe("Notes/A.md");
  });

  it("returns null when there is no active note", () => {
    expect(effectiveActiveNote({ activePath: null, explicit: [] })).toBeNull();
  });

  it("defers to an explicit attachment of the same note (explicit wins, no double-attach)", () => {
    expect(effectiveActiveNote({ activePath: "Notes/A.md", explicit: ["Notes/A.md"] })).toBeNull();
    // A different explicit attachment doesn't suppress the active note.
    expect(effectiveActiveNote({ activePath: "Notes/A.md", explicit: ["Other.md"] })).toBe("Notes/A.md");
  });

  it("skips only the note whose selected text is attached", () => {
    const base = { explicit: [], selectedTextSources: ["Notes/A.md"] };
    expect(effectiveActiveNote({ activePath: "Notes/A.md", ...base })).toBeNull();
    expect(effectiveActiveNote({ activePath: "Notes/B.md", ...base })).toBe("Notes/B.md");
  });
});

describe("autoActiveNotePath", () => {
  const allowed = () => false;

  it("uses the active Markdown file", () => {
    expect(autoActiveNotePath({ path: "Notes/A.md", extension: "md" }, { isIgnored: allowed })).toBe("Notes/A.md");
  });

  it("skips non-Markdown active files", () => {
    expect(autoActiveNotePath({ path: "Image.png", extension: "png" }, { isIgnored: allowed })).toBeNull();
  });

  it("skips ignored active files so private paths are never named", () => {
    expect(
      autoActiveNotePath({ path: "Private/Secret.md", extension: "md" }, { isIgnored: (path) => path.startsWith("Private/") }),
    ).toBeNull();
  });
});

describe("privateActiveNotePath", () => {
  it("names the focused note only when it is private (for the lock chip)", () => {
    const isIgnored = (path: string) => path.startsWith("Private/");
    expect(privateActiveNotePath({ path: "Private/S.md", extension: "md" }, { isIgnored })).toBe("Private/S.md");
    expect(privateActiveNotePath({ path: "Notes/A.md", extension: "md" }, { isIgnored })).toBeNull();
  });
});

describe("buildActiveNotePointer", () => {
  it("names the note and says its text is not attached", () => {
    const pointer = buildActiveNotePointer({ path: "A.md", openPaths: [] });
    expect(pointer).toContain('Active note "A.md"');
    expect(pointer).toMatch(/text is not attached/);
    expect(pointer).not.toContain("Other open notes");
  });

  it("lists the other open notes, capped", () => {
    const open = Array.from({ length: MAX_OPEN_NOTES + 5 }, (_, index) => `N${index}.md`);
    const pointer = buildActiveNotePointer({ path: "A.md", openPaths: open });
    expect(pointer).toContain('"N0.md"');
    expect(pointer).toContain(`"N${MAX_OPEN_NOTES - 1}.md"`);
    expect(pointer).not.toContain(`"N${MAX_OPEN_NOTES}.md"`);
  });

  it("quotes a short selection and names a long one by size", () => {
    expect(buildActiveNotePointer({ path: "A.md", openPaths: [], selection: "pick me" })).toContain("Selected text in it:\npick me");
    const long = "x".repeat(MAX_POINTER_SELECTION_CHARS + 1);
    const pointer = buildActiveNotePointer({ path: "A.md", openPaths: [], selection: long });
    expect(pointer).not.toContain(long);
    expect(pointer).toMatch(/characters are selected/);
  });

  it("carries nothing that changes on every edit (no counts, no properties)", () => {
    const pointer = buildActiveNotePointer({ path: "A.md", openPaths: ["B.md"] });
    expect(pointer).not.toMatch(/\d+ (lines|words|characters)/);
  });
});
