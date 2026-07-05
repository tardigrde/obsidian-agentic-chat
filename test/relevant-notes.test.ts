import { describe, expect, it } from "vitest";
import {
  buildRelevantNotesPanelState,
  excludeRelevantNote,
  markdownToRetrievalDocument,
  pinRelevantNote,
  unpinRelevantNote,
} from "../src/retrieval/relevant-notes";
import type { RetrievalDocument } from "../src/retrieval/policy";
import { createEmbeddingIndexSnapshot, type EmbeddingIndexRecord } from "../src/retrieval/embeddings";
import { createIgnoreMatcher } from "../src/vault/ignore";

const now = Date.UTC(2026, 5, 26);

function doc(path: string, content: string, modifiedTime = now): RetrievalDocument {
  return markdownToRetrievalDocument({
    id: path,
    path,
    basename: path.split("/").pop()?.replace(/\.md$/, "") ?? path,
    content,
    modifiedTime,
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

describe("buildRelevantNotesPanelState", () => {
  const documents = [
    doc("Projects/Alpha.md", "# Alpha Plan\n#project\nSee [[Notes/Research.md]].\nOAuth launch diagnostics."),
    doc("Notes/Research.md", "# Research\nBacklinks and OAuth diagnostics for alpha launch."),
    doc("Notes/Side.md", "# Side Note\nAlpha launch checklist."),
    doc("Notes/Unrelated.md", "# Garden\nRecipes and travel packing."),
    doc("Private/Secret.md", "# Secret\nOAuth diagnostics alpha launch."),
  ];

  it("refreshes suggestions from the active note with deterministic lexical/link ranking", () => {
    const state = buildRelevantNotesPanelState({
      activePath: "Projects/Alpha.md",
      documents,
      ignoreMatcher: createIgnoreMatcher(["Private/"]),
      now,
    });

    expect(state.emptyReason).toBeNull();
    expect(state.ignoredCount).toBe(1);
    expect(state.suggestions.map((suggestion) => suggestion.path)).toEqual(["Notes/Research.md", "Notes/Side.md"]);
    expect(state.suggestions[0]?.why.join("\n")).toContain("active note");
  });

  it("applies pin and exclude controls", () => {
    const pinned = pinRelevantNote({}, "Notes/Side.md");
    const excluded = excludeRelevantNote(pinned, "Notes/Research.md");
    const state = buildRelevantNotesPanelState({
      activePath: "Projects/Alpha.md",
      documents,
      controls: excluded,
      ignoreMatcher: createIgnoreMatcher(["Private/"]),
      maxResults: 3,
      now,
    });

    expect(state.suggestions.map((suggestion) => suggestion.path)).toEqual(["Notes/Side.md"]);
    expect(state.suggestions[0]?.pinned).toBe(true);
    expect(unpinRelevantNote(excluded, "Notes/Side.md").pinnedPaths).toEqual([]);
  });

  it("limits suggestions to the active project folder scope", () => {
    const scopedDocs = [
      doc("Projects/Alpha/Home.md", "# Alpha Home\nSee [[Projects/Alpha/Related.md]].\nLaunch diagnostics."),
      doc("Projects/Alpha/Related.md", "# Alpha Related\nLaunch diagnostics and alpha decisions."),
      doc("Projects/Beta/Related.md", "# Beta Related\nLaunch diagnostics and beta decisions."),
    ];

    const state = buildRelevantNotesPanelState({
      activePath: "Projects/Alpha/Home.md",
      documents: scopedDocs,
      scopeFolders: ["Projects/Alpha"],
      now,
    });

    expect(state.suggestions.map((suggestion) => suggestion.path)).toEqual(["Projects/Alpha/Related.md"]);
  });

  it("uses a semantic index to surface related notes when lexical signals miss", () => {
    const semanticDocs = [
      doc("Notes/Active.md", "# Active\nUse compact memory notes."),
      doc("Notes/Semantic.md", "# Different words\nDurable preference storage and recall."),
      doc("Notes/Other.md", "# Other\nTravel packing."),
    ];
    const model = {
      id: "test/embed",
      provider: "test",
      dimensions: 2,
      execution: "local-cpu" as const,
      languageCoverage: "multilingual" as const,
      requiresNetwork: false,
    };
    const semanticIndex = createEmbeddingIndexSnapshot({
      scope: { kind: "vault", label: "Whole vault" },
      model,
      records: [
        semanticRecord(semanticDocs[0], [1, 0], model),
        semanticRecord(semanticDocs[1], [0.98, 0.02], model),
        semanticRecord(semanticDocs[2], [-1, 0], model),
      ],
      now,
    });

    const withoutIndex = buildRelevantNotesPanelState({
      activePath: "Notes/Active.md",
      documents: semanticDocs,
      now,
    });
    const withIndex = buildRelevantNotesPanelState({
      activePath: "Notes/Active.md",
      documents: semanticDocs,
      semanticIndex,
      now,
    });

    expect(withoutIndex.suggestions.map((suggestion) => suggestion.path)).toEqual([]);
    expect(withIndex.suggestions.map((suggestion) => suggestion.path)).toEqual(["Notes/Semantic.md"]);
    expect(withIndex.suggestions[0]?.why.join("\n")).toContain("semantic similarity");
  });

  it("returns explicit empty states", () => {
    expect(buildRelevantNotesPanelState({ activePath: null, documents }).emptyReason).toBe("no-active-note");
    expect(
      buildRelevantNotesPanelState({
        activePath: "Private/Secret.md",
        documents,
        ignoreMatcher: createIgnoreMatcher(["Private/"]),
      }).emptyReason,
    ).toBe("active-note-ignored");
    expect(buildRelevantNotesPanelState({ activePath: "Missing.md", documents }).emptyReason).toBe("active-note-missing");
    expect(
      buildRelevantNotesPanelState({
        activePath: "Notes/Unrelated.md",
        documents: [documents[3]],
      }).emptyReason,
    ).toBe("no-related-notes");
  });
});

function semanticRecord(
  document: RetrievalDocument,
  vector: readonly number[],
  model: { id: string; dimensions: number },
): EmbeddingIndexRecord {
  return {
    documentId: document.id,
    path: document.path,
    modelId: model.id,
    dimensions: model.dimensions,
    contentHash: document.id,
    updatedAt: now,
    vector,
  };
}
