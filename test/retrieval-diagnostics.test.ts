import { describe, expect, it } from "vitest";
import {
  applyRetrievalRankingControls,
  buildRetrievalDiagnostics,
  parseRetrievalDiagnostics,
  serializeRetrievalDiagnostics,
} from "../src/retrieval/diagnostics";
import { retrieveLexicalVaultCandidates } from "../src/retrieval/lexical";
import { buildRetrievalLanguagePolicy } from "../src/retrieval/policy";
import { MULTILINGUAL_RETRIEVAL_FIXTURE } from "./helpers/retrieval-fixtures";

describe("retrieval diagnostics", () => {
  it("explains score components for each retrieved result", () => {
    const response = retrieveLexicalVaultCandidates(
      { text: "MCP OAuth diagnostics", activePath: "Projects/MCP OAuth.md", now: Date.UTC(2026, 5, 13) },
      { documents: MULTILINGUAL_RETRIEVAL_FIXTURE },
    );

    const diagnostics = buildRetrievalDiagnostics(response);
    const first = diagnostics.results[0];

    expect(first?.path).toBe("Projects/MCP OAuth.md");
    expect(first?.scoreComponents.map((component) => component.kind)).toEqual([
      "path",
      "title",
      "body",
      "tag",
      "active-note",
      "recency",
    ]);
    expect(first?.why[0]).toBe("Matched path: mcp, oauth (+2.8)");
    expect(first?.controlState).toEqual({
      pinned: false,
      excluded: false,
      moreLikeThisAvailable: true,
    });
  });

  it("applies pin and exclude controls without mutating the underlying response", () => {
    const response = retrieveLexicalVaultCandidates(
      { text: "MCP" },
      { documents: MULTILINGUAL_RETRIEVAL_FIXTURE },
    );

    const controlled = applyRetrievalRankingControls(response.results, {
      pinnedPaths: ["Research/Retrieval.md"],
      excludedPaths: ["Projects/MCP OAuth.md"],
    });
    const diagnostics = buildRetrievalDiagnostics(response, {
      controls: {
        pinnedPaths: ["Research/Retrieval.md"],
        excludedPaths: ["Projects/MCP OAuth.md"],
      },
    });

    expect(response.results[0]?.document.path).toBe("Projects/MCP OAuth.md");
    expect(controlled.map((result) => result.document.path)).not.toContain("Projects/MCP OAuth.md");
    expect(controlled[0]?.document.path).toBe("Research/Retrieval.md");
    expect(diagnostics.results[0]?.controlState.pinned).toBe(true);
  });

  it("surfaces multilingual retrieval limitations in the diagnostics bundle", () => {
    const response = retrieveLexicalVaultCandidates(
      { text: "agent audit" },
      { documents: MULTILINGUAL_RETRIEVAL_FIXTURE },
    );
    const languagePolicy = buildRetrievalLanguagePolicy({
      queryLanguage: "hu",
      documentLanguages: MULTILINGUAL_RETRIEVAL_FIXTURE.map((document) => document.language),
      hasMultilingualEmbeddings: false,
    });

    const diagnostics = buildRetrievalDiagnostics(response, { languagePolicy });

    expect(diagnostics.languageMode).toBe("cross-language-limited");
    expect(diagnostics.languageLimitations).toEqual([
      "Cross-language retrieval is limited without multilingual embeddings or query expansion.",
    ]);
  });

  it("creates more-like-this seeds from result metadata", () => {
    const response = retrieveLexicalVaultCandidates(
      { text: "retrieval" },
      { documents: MULTILINGUAL_RETRIEVAL_FIXTURE },
    );
    const diagnostics = buildRetrievalDiagnostics(response);

    expect(diagnostics.results[0]?.moreLikeThis).toMatchObject({
      documentId: "en-retrieval",
      path: "Research/Retrieval.md",
      tags: ["retrieval", "rag"],
      links: ["Projects/MCP OAuth.md"],
    });
  });

  it("serializes diagnostics as stable JSON for future session artifacts", () => {
    const response = retrieveLexicalVaultCandidates(
      { text: "OAuth" },
      { documents: MULTILINGUAL_RETRIEVAL_FIXTURE },
    );
    const diagnostics = buildRetrievalDiagnostics(response);

    expect(parseRetrievalDiagnostics(serializeRetrievalDiagnostics(diagnostics))).toEqual(diagnostics);
  });
});
