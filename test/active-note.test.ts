import { describe, expect, it } from "vitest";
import {
  ActiveNoteContextCache,
  autoActiveNotePath,
  buildActiveNoteSection,
  effectiveActiveNote,
  MAX_ACTIVE_NOTE_CHARS,
} from "../src/ui/active-note";

describe("effectiveActiveNote", () => {
  it("auto-attaches the active note by default", () => {
    expect(effectiveActiveNote({ activePath: "Notes/A.md", suppressed: false, explicit: [] })).toBe("Notes/A.md");
  });

  it("returns null when there is no active note", () => {
    expect(effectiveActiveNote({ activePath: null, suppressed: false, explicit: [] })).toBeNull();
  });

  it("stays suppressed once the user removed the auto chip", () => {
    expect(effectiveActiveNote({ activePath: "Notes/A.md", suppressed: true, explicit: [] })).toBeNull();
  });

  it("defers to an explicit attachment of the same note (explicit wins, no double-attach)", () => {
    expect(effectiveActiveNote({ activePath: "Notes/A.md", suppressed: false, explicit: ["Notes/A.md"] })).toBeNull();
    // A different explicit attachment doesn't suppress the active note.
    expect(effectiveActiveNote({ activePath: "Notes/A.md", suppressed: false, explicit: ["Other.md"] })).toBe("Notes/A.md");
  });

  it("suppresses only the note whose selected text is attached", () => {
    expect(
      effectiveActiveNote({
        activePath: "Notes/A.md",
        suppressed: false,
        explicit: [],
        selectedTextSources: ["Notes/A.md"],
      }),
    ).toBeNull();
    expect(
      effectiveActiveNote({
        activePath: "Notes/B.md",
        suppressed: false,
        explicit: [],
        selectedTextSources: ["Notes/A.md"],
      }),
    ).toBe("Notes/B.md");
  });
});

describe("autoActiveNotePath", () => {
  const allowed = () => false;

  it("uses the active Markdown file by default", () => {
    expect(autoActiveNotePath({ path: "Notes/A.md", extension: "md" }, { suppressed: false, isIgnored: allowed })).toBe(
      "Notes/A.md",
    );
  });

  it("skips non-Markdown active files", () => {
    expect(autoActiveNotePath({ path: "Image.png", extension: "png" }, { suppressed: false, isIgnored: allowed })).toBeNull();
  });

  it("skips ignored active files so private paths are not auto-shown", () => {
    expect(
      autoActiveNotePath(
        { path: "Private/Secret.md", extension: "md" },
        { suppressed: false, isIgnored: (path) => path.startsWith("Private/") },
      ),
    ).toBeNull();
  });

  it("stays suppressed even for an otherwise eligible Markdown file", () => {
    expect(autoActiveNotePath({ path: "Notes/A.md", extension: "md" }, { suppressed: true, isIgnored: allowed })).toBeNull();
  });
});

describe("buildActiveNoteSection (truncation ladder)", () => {
  it("inlines the full note when it fits the budget", () => {
    const section = buildActiveNoteSection({ path: "A.md", full: "short body", limit: MAX_ACTIVE_NOTE_CHARS });
    expect(section).toContain('Active note "A.md"');
    expect(section).toContain("short body");
    expect(section).not.toMatch(/too long/i);
  });

  it("falls back to the visible editor range when the full note is too long", () => {
    const full = "x".repeat(50);
    const section = buildActiveNoteSection({ path: "A.md", full, visibleRange: "visible slice", limit: 10 });
    expect(section).toMatch(/visible in the editor/i);
    expect(section).toContain("visible slice");
    expect(section).not.toContain(full);
  });

  it("falls back to a labeled path-only reference when no visible range is available", () => {
    const section = buildActiveNoteSection({ path: "A.md", full: "x".repeat(50), visibleRange: null, limit: 10 });
    expect(section).toMatch(/by reference/i);
    expect(section).toMatch(/read tool/i);
    expect(section).toContain("A.md");
  });

  it("uses path-only when the note can't be read at all", () => {
    const section = buildActiveNoteSection({ path: "A.md", full: null, limit: MAX_ACTIVE_NOTE_CHARS });
    expect(section).toMatch(/by reference/i);
  });

  it("treats a blank visible range as unavailable", () => {
    const section = buildActiveNoteSection({ path: "A.md", full: "x".repeat(50), visibleRange: "   ", limit: 10 });
    expect(section).toMatch(/by reference/i);
  });
});

describe("ActiveNoteContextCache (unchanged-body dedupe)", () => {
  it("inlines the full body on the first turn and a compact marker once the same body is committed", () => {
    const cache = new ActiveNoteContextCache();
    const first = cache.render({ path: "A.md", full: "same body", limit: MAX_ACTIVE_NOTE_CHARS });
    expect(first).toContain("same body");
    cache.commitPending();
    const second = cache.render({ path: "A.md", full: "same body", limit: MAX_ACTIVE_NOTE_CHARS });
    expect(second).toMatch(/unchanged since it was already attached/i);
    expect(second).not.toContain("same body");
  });

  it("re-inlines the body when the note changed between turns", () => {
    const cache = new ActiveNoteContextCache();
    cache.render({ path: "A.md", full: "first body", limit: MAX_ACTIVE_NOTE_CHARS });
    cache.commitPending();
    const second = cache.render({ path: "A.md", full: "edited body", limit: MAX_ACTIVE_NOTE_CHARS });
    expect(second).toContain("edited body");
    expect(second).not.toMatch(/unchanged since/i);
  });

  it("discarding pending state leaves the previous turn uncached, so the body is inlined again", () => {
    const cache = new ActiveNoteContextCache();
    cache.render({ path: "A.md", full: "body", limit: MAX_ACTIVE_NOTE_CHARS });
    cache.discardPending();
    const second = cache.render({ path: "A.md", full: "body", limit: MAX_ACTIVE_NOTE_CHARS });
    expect(second).toContain("body");
    expect(second).not.toMatch(/unchanged since/i);
  });

  it("clear() forgets committed bodies", () => {
    const cache = new ActiveNoteContextCache();
    cache.render({ path: "A.md", full: "body", limit: MAX_ACTIVE_NOTE_CHARS });
    cache.commitPending();
    cache.clear();
    const second = cache.render({ path: "A.md", full: "body", limit: MAX_ACTIVE_NOTE_CHARS });
    expect(second).toContain("body");
  });

  it("tracks distinct notes independently", () => {
    const cache = new ActiveNoteContextCache();
    cache.render({ path: "A.md", full: "body-a", limit: MAX_ACTIVE_NOTE_CHARS });
    cache.commitPending();
    const b = cache.render({ path: "B.md", full: "body-a", limit: MAX_ACTIVE_NOTE_CHARS });
    expect(b).toContain("body-a");
  });
});
