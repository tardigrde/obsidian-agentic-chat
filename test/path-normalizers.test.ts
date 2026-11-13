import { describe, expect, it } from "vitest";
import { normalizeVaultPath } from "../src/vault/path";
import { normalizePath as normalizeLexicalPath } from "../src/retrieval/lexical";
import { normalizePath as normalizeDiagnosticsPath } from "../src/retrieval/diagnostics";
import { normalizePath as normalizeRelevantNotesPath } from "../src/retrieval/relevant-notes";
import { normalizePath as normalizeAuditPath } from "../src/agent/action-audit-log";
import { normalizeNotePath } from "../src/retrieval/citations";
import { normalizeSourcePath } from "../src/retrieval/source-ingest";

type PathNormalizer = (input: string) => string | undefined;

/** Render a value or the fact that the normalizer rejected the input. */
function outcome(normalize: PathNormalizer, input: string): string {
  try {
    const value = normalize(input);
    return value === undefined ? "<undefined>" : value;
  } catch {
    return "<throws>";
  }
}

interface PathCase {
  input: string;
  vault: string;
  lookup: string;
  audit: string;
  source: string;
  citation: string;
}

/**
 * Pins the behaviour of every path-normalizer copy before and after the merge.
 * The `vault` column is the canonical normalizer. `lookup` covers the three
 * retrieval copies that were identical; `audit`, `source`, and `citation` are
 * the copies with different semantics that stay separate.
 */
const CASES: readonly PathCase[] = [
  {
    input: "Folder/Note.md",
    vault: "Folder/Note.md",
    lookup: "folder/note.md",
    audit: "Folder/Note.md",
    source: "folder/note.md",
    citation: "Folder/Note.md",
  },
  {
    input: "/Folder/Note.md",
    vault: "<throws>",
    lookup: "folder/note.md",
    audit: "Folder/Note.md",
    source: "/folder/note.md",
    citation: "Folder/Note.md",
  },
  {
    input: "Folder/Note.md/",
    vault: "Folder/Note.md",
    lookup: "folder/note.md/",
    audit: "Folder/Note.md/",
    source: "folder/note.md/",
    citation: "Folder/Note.md/",
  },
  {
    input: "Folder\\Note.md",
    vault: "Folder/Note.md",
    lookup: "folder/note.md",
    audit: "Folder/Note.md",
    source: "folder/note.md",
    citation: "Folder/Note.md",
  },
  {
    input: "./Folder/Note.md",
    vault: "Folder/Note.md",
    lookup: "./folder/note.md",
    audit: "./Folder/Note.md",
    source: "./folder/note.md",
    citation: "./Folder/Note.md",
  },
  {
    input: "Folder/../Note.md",
    vault: "<throws>",
    lookup: "folder/../note.md",
    audit: "Folder/../Note.md",
    source: "folder/../note.md",
    citation: "Folder/../Note.md",
  },
  {
    input: "Folder//Note.md",
    vault: "Folder/Note.md",
    lookup: "folder/note.md",
    audit: "Folder/Note.md",
    source: "folder/note.md",
    citation: "Folder/Note.md",
  },
  {
    input: " Folder / Note.md ",
    vault: "Folder / Note.md",
    lookup: "folder / note.md",
    audit: "Folder / Note.md",
    source: "folder / note.md",
    citation: "Folder / Note.md",
  },
  {
    input: "",
    vault: "",
    lookup: "",
    audit: "",
    source: "",
    citation: "<undefined>",
  },
  {
    input: "Ünicode/Note.md",
    vault: "Ünicode/Note.md",
    lookup: "ünicode/note.md",
    audit: "Ünicode/Note.md",
    source: "ünicode/note.md",
    citation: "Ünicode/Note.md",
  },
  {
    input: "@Folder/Note.md",
    vault: "@Folder/Note.md",
    lookup: "@folder/note.md",
    audit: "@Folder/Note.md",
    source: "@folder/note.md",
    citation: "@Folder/Note.md",
  },
  {
    input: "folder/Note.MD",
    vault: "folder/Note.MD",
    lookup: "folder/note.md",
    audit: "folder/Note.MD",
    source: "folder/note.md",
    citation: "folder/Note.MD",
  },
  {
    input: "plugins/agentic-chat/data.json",
    vault: "<throws>",
    lookup: "plugins/agentic-chat/data.json",
    audit: "plugins/agentic-chat/data.json",
    source: "plugins/agentic-chat/data.json",
    citation: "plugins/agentic-chat/data.json",
  },
  {
    input: "a:b.md",
    vault: "a:b.md",
    lookup: "a:b.md",
    audit: "a:b.md",
    source: "a:b.md",
    citation: "<undefined>",
  },
  {
    input: "a[b].md",
    vault: "a[b].md",
    lookup: "a[b].md",
    audit: "a[b].md",
    source: "a[b].md",
    citation: "<undefined>",
  },
];

function column(normalize: PathNormalizer, key: Exclude<keyof PathCase, "input">): string[] {
  return CASES.map((entry) => {
    const expected = entry[key];
    // The lookup column also pins the three retrieval copies against each other.
    if (key === "lookup") {
      expect(outcome(normalizeRelevantNotesPath, entry.input)).toBe(expected);
      expect(outcome(normalizeDiagnosticsPath, entry.input)).toBe(expected);
    }
    return outcome(normalize, entry.input);
  });
}

function expectedColumn(key: Exclude<keyof PathCase, "input">): string[] {
  return CASES.map((entry) => entry[key]);
}

describe("path normalizers", () => {
  it("keeps the canonical vault normalizer strict and vault-relative", () => {
    expect(column(normalizeVaultPath, "vault")).toEqual(expectedColumn("vault"));
  });

  it("keeps the retrieval lookup copies identical", () => {
    expect(column(normalizeLexicalPath, "lookup")).toEqual(expectedColumn("lookup"));
  });

  it("keeps the audit copy case-preserving", () => {
    expect(column(normalizeAuditPath, "audit")).toEqual(expectedColumn("audit"));
  });

  it("keeps the source copy's leading-slash behaviour", () => {
    expect(column(normalizeSourcePath, "source")).toEqual(expectedColumn("source"));
  });

  it("keeps citation paths case-preserving with brackets and colons rejected", () => {
    expect(column(normalizeNotePath, "citation")).toEqual(expectedColumn("citation"));
  });
});
