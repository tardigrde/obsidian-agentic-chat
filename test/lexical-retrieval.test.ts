import { describe, expect, it } from "vitest";
import { retrieveLexicalVaultCandidates, tokenizeRetrievalQuery } from "../src/retrieval/lexical";
import type { RetrievalDocument } from "../src/retrieval/policy";
import { createIgnoreMatcher } from "../src/vault/ignore";
import { MULTILINGUAL_RETRIEVAL_FIXTURE } from "./helpers/retrieval-fixtures";

const now = Date.UTC(2026, 5, 13);

describe("tokenizeRetrievalQuery", () => {
  it("deduplicates query tokens and keeps non-English word tokens", () => {
    expect(tokenizeRetrievalQuery("OAuth oauth agent naplo")).toEqual(["oauth", "agent", "naplo"]);
  });
});

describe("retrieveLexicalVaultCandidates", () => {
  it("ranks path, title, body, metadata, graph, active-note, and recency signals without embeddings", () => {
    const response = retrieveLexicalVaultCandidates(
      { text: "MCP OAuth platform security diagnostics", activePath: "Projects/MCP OAuth.md", now },
      { documents: MULTILINGUAL_RETRIEVAL_FIXTURE },
    );

    expect(response.queryTokens).toEqual(["mcp", "oauth", "platform", "security", "diagnostics"]);
    expect(response.results[0]?.document.id).toBe("en-mcp-oauth");
    expect(response.results[0]?.signals.map((signal) => signal.kind)).toEqual([
      "path",
      "title",
      "body",
      "tag",
      "frontmatter",
      "link",
      "active-note",
      "recency",
    ]);
    expect(response.results[0]?.snippets).toEqual([
      "1: OAuth refresh tokens need reauth, scope step-up, and clear diagnostics.",
    ]);
  });

  it("matches aliases, links, and backlinks for cross-note candidate discovery", () => {
    const response = retrieveLexicalVaultCandidates(
      { text: "audit MCP", activePath: "Projects/MCP OAuth.md", now },
      { documents: MULTILINGUAL_RETRIEVAL_FIXTURE },
    );

    const huNote = response.results.find((result) => result.document.id === "hu-agent-naplo");
    expect(huNote?.signals.map((signal) => signal.kind)).toContain("alias");
    expect(huNote?.signals.map((signal) => signal.kind)).toContain("link");
    expect(huNote?.signals.map((signal) => signal.kind)).toContain("active-note");
  });

  it("enforces ignore-list boundaries before scoring candidates", () => {
    const documents: RetrievalDocument[] = [
      ...MULTILINGUAL_RETRIEVAL_FIXTURE,
      {
        id: "private-secret",
        path: "Private/Secret.md",
        title: "Secret MCP OAuth notes",
        content: "MCP OAuth credentials and diagnostics.",
        language: "en",
      },
    ];

    const response = retrieveLexicalVaultCandidates(
      { text: "secret MCP OAuth" },
      {
        documents,
        ignoreMatcher: createIgnoreMatcher(["Private/"]),
      },
    );

    expect(response.ignoredCount).toBe(1);
    expect(response.results.map((result) => result.document.path)).not.toContain("Private/Secret.md");
  });

  it("supports capped and paginated result windows", () => {
    const documents: RetrievalDocument[] = Array.from({ length: 5 }, (_unused, index) => ({
      id: `alpha-${index}`,
      path: `Notes/Alpha ${index}.md`,
      title: `Alpha ${index}`,
      content: `alpha result ${index}`,
      language: "en",
      modifiedTime: Date.UTC(2026, 5, index + 1),
    }));

    const firstPage = retrieveLexicalVaultCandidates(
      { text: "alpha", maxResults: 2 },
      { documents },
    );
    const secondPage = retrieveLexicalVaultCandidates(
      { text: "alpha", maxResults: 2, offset: firstPage.nextOffset },
      { documents },
    );

    expect(firstPage.totalMatches).toBe(5);
    expect(firstPage.results).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextOffset).toBe(2);
    expect(secondPage.results.map((result) => result.document.id)).toEqual(["alpha-2", "alpha-1"]);
  });

  it("returns an empty response when neither query nor active note can select a candidate", () => {
    const response = retrieveLexicalVaultCandidates(
      { text: "" },
      { documents: MULTILINGUAL_RETRIEVAL_FIXTURE },
    );

    expect(response.results).toEqual([]);
    expect(response.totalMatches).toBe(0);
  });
});
