import { describe, expect, it } from "vitest";
import { createEmbeddingIndexSnapshot, type EmbeddingIndexRecord } from "../src/retrieval/embeddings";
import { retrieveLexicalVaultCandidates } from "../src/retrieval/lexical";
import {
  cosineSimilarity,
  mergeSemanticCandidates,
  retrieveSemanticVaultCandidates,
} from "../src/retrieval/semantic";
import type { RetrievalDocument } from "../src/retrieval/policy";

const docs: RetrievalDocument[] = [
  { id: "alpha", path: "Notes/Alpha.md", title: "Alpha", content: "OAuth token refresh", modifiedTime: 3 },
  { id: "bravo", path: "Notes/Bravo.md", title: "Bravo", content: "Authorization renewal", modifiedTime: 2 },
  { id: "charlie", path: "Notes/Charlie.md", title: "Charlie", content: "Garden recipes", modifiedTime: 1 },
];

const model = {
  id: "test/embed",
  provider: "test",
  dimensions: 2,
  execution: "local-cpu" as const,
  languageCoverage: "multilingual" as const,
  requiresNetwork: false,
};

function record(documentId: string, vector: readonly number[]): EmbeddingIndexRecord {
  const doc = docs.find((item) => item.id === documentId)!;
  return {
    documentId,
    path: doc.path,
    modelId: model.id,
    dimensions: model.dimensions,
    contentHash: documentId,
    updatedAt: 1,
    vector,
  };
}

describe("semantic retrieval", () => {
  it("scores indexed documents by cosine similarity with model/dimension guards", () => {
    const snapshot = createEmbeddingIndexSnapshot({
      scope: { kind: "vault", label: "Whole vault" },
      model,
      records: [record("alpha", [1, 0]), record("bravo", [0.9, 0.1]), record("charlie", [-1, 0])],
      now: 1,
    });

    const results = retrieveSemanticVaultCandidates({
      documents: docs,
      snapshot,
      queryEmbedding: { modelId: model.id, dimensions: 2, values: [1, 0] },
      minSimilarity: 0.2,
    });

    expect(cosineSimilarity([1, 0], [0.9, 0.1])).toBeCloseTo(0.993884);
    expect(results.map((result) => result.document.id)).toEqual(["alpha", "bravo"]);
    expect(
      retrieveSemanticVaultCandidates({
        documents: docs,
        snapshot,
        queryEmbedding: { modelId: "other", dimensions: 2, values: [1, 0] },
      }),
    ).toEqual([]);
  });

  it("merges semantic-only and lexical matches while preserving fallback behavior", () => {
    const lexical = retrieveLexicalVaultCandidates({ text: "oauth", maxResults: 10 }, { documents: docs });
    const snapshot = createEmbeddingIndexSnapshot({
      scope: { kind: "vault", label: "Whole vault" },
      model,
      records: [record("alpha", [1, 0]), record("bravo", [0.95, 0.05]), record("charlie", [-1, 0])],
      now: 1,
    });
    const semantic = retrieveSemanticVaultCandidates({
      documents: docs,
      snapshot,
      queryEmbedding: { modelId: model.id, dimensions: 2, values: [1, 0] },
      minSimilarity: 0.2,
    });
    const hybrid = mergeSemanticCandidates(lexical, semantic, { maxResults: 10 });

    expect(lexical.results.map((result) => result.document.id)).toEqual(["alpha"]);
    expect(hybrid.results.map((result) => result.document.id)).toEqual(["alpha", "bravo"]);
    expect(hybrid.results[0]?.signals.map((signal) => signal.kind)).toContain("semantic");
    expect(hybrid.results[1]?.signals).toEqual([
      expect.objectContaining({ kind: "semantic", detail: "semantic similarity" }),
    ]);
  });
});
