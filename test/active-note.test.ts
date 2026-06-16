import { describe, expect, it } from "vitest";
import { buildActiveNoteSection, effectiveActiveNote, MAX_ACTIVE_NOTE_CHARS } from "../src/ui/active-note";

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
