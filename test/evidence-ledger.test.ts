import { describe, expect, it } from "vitest";
import { ToolArtifactStore } from "../src/artifacts/tool-artifact-store";
import {
  EVIDENCE_LEDGER_CONTENT_TYPE,
  EVIDENCE_LEDGER_SOURCE_TOOL,
  addEvidenceClaim,
  addEvidenceSource,
  addRetrievalDiagnostics,
  createEvidenceLedger,
  parseEvidenceLedger,
  readEvidenceLedgerArtifact,
  serializeEvidenceLedger,
  writeEvidenceLedgerArtifact,
} from "../src/retrieval/evidence-ledger";
import { buildRetrievalDiagnostics } from "../src/retrieval/diagnostics";
import { retrieveLexicalVaultCandidates } from "../src/retrieval/lexical";
import { createIgnoreMatcher } from "../src/vault/ignore";
import { MemoryAdapter } from "./helpers/memory-adapter";
import { MULTILINGUAL_RETRIEVAL_FIXTURE } from "./helpers/retrieval-fixtures";

const FIXED_NOW = Date.UTC(2026, 5, 26, 8, 0, 0);

describe("Evidence ledger", () => {
  it("records citable note, URL, and source artifact references for generated claims", () => {
    let ledger = createEvidenceLedger({
      sessionId: "session-1",
      title: "Research QA",
      now: () => FIXED_NOW,
    });

    const note = addEvidenceSource(
      ledger,
      {
        reference: "[[Notes/Plan.md#Decision|Decision note]]",
        excerpt: "Use a lexical retrieval ladder before embeddings.",
      },
      { now: () => FIXED_NOW + 1 },
    );
    ledger = note.ledger;
    const block = addEvidenceSource(ledger, { reference: "[[Notes/Plan.md#^block-1]]" }, { now: () => FIXED_NOW + 2 });
    ledger = block.ledger;
    const url = addEvidenceSource(
      ledger,
      { reference: "[Spec](https://example.com/source)", metadata: { fetched: true } },
      { now: () => FIXED_NOW + 3 },
    );
    ledger = url.ledger;
    const artifact = addEvidenceSource(
      ledger,
      { reference: "[Imported PDF](artifact:tool-abc_123)" },
      { now: () => FIXED_NOW + 4 },
    );
    ledger = artifact.ledger;

    const duplicate = addEvidenceSource(ledger, { reference: "https://example.com/source" }, { now: () => FIXED_NOW + 5 });
    ledger = addEvidenceClaim(
      duplicate.ledger,
      {
        id: "claim-retrieval-first",
        text: "The research workflow should prefer lexical and graph signals before optional embeddings.",
        sourceKeys: [note.sourceKey ?? "", block.sourceKey ?? "", url.sourceKey ?? "", artifact.sourceKey ?? ""],
      },
      { now: () => FIXED_NOW + 6 },
    );

    expect(duplicate.sourceKey).toBe(url.sourceKey);
    expect(ledger.sources).toHaveLength(4);
    expect(ledger.claims).toEqual([
      expect.objectContaining({
        id: "claim-retrieval-first",
        sourceKeys: [note.sourceKey, block.sourceKey, url.sourceKey, artifact.sourceKey],
      }),
    ]);
    expect(serializeEvidenceLedger(ledger)).toContain("[[Notes/Plan.md#Decision|Decision note]]");
    expect(serializeEvidenceLedger(ledger)).toContain("[Spec](https://example.com/source)");
    expect(serializeEvidenceLedger(ledger)).toContain("[Imported PDF](artifact:tool-abc_123)");
  });

  it("persists retrieval diagnostics with the evidence trail", () => {
    const retrieval = retrieveLexicalVaultCandidates(
      { text: "OAuth refresh diagnostics", now: Date.UTC(2026, 5, 26), maxResults: 2 },
      { documents: MULTILINGUAL_RETRIEVAL_FIXTURE },
    );
    const diagnostics = buildRetrievalDiagnostics(retrieval);

    const ledger = addRetrievalDiagnostics(
      createEvidenceLedger({ now: () => FIXED_NOW }),
      diagnostics,
      { id: "retrieval-oauth", now: () => FIXED_NOW + 1 },
    );
    const serialized = serializeEvidenceLedger(ledger);

    expect(ledger.diagnostics).toHaveLength(1);
    expect(serialized).toContain("OAuth");
    expect(serialized).toContain("Projects/MCP OAuth.md");
    expect(serialized).toContain("Matched body");
  });

  it("redacts ignored note sources without leaking private path, label, or excerpt text", () => {
    const ignoreMatcher = createIgnoreMatcher(["Private/"]);
    const input = {
      reference: "[[Private/Secret.md#Password|private password]]",
      excerpt: "the hidden token is abc123",
      metadata: { localPath: "Private/Secret.md" },
    };
    const result = addEvidenceSource(createEvidenceLedger({ now: () => FIXED_NOW }), input, {
      ignoreMatcher,
      now: () => FIXED_NOW + 1,
    });
    const serialized = serializeEvidenceLedger(result.ledger);

    expect(result.redacted).toBe(true);
    expect(result.sourceKey).toBeUndefined();
    expect(result.ledger.sources).toHaveLength(0);
    expect(result.ledger.redactions).toEqual([
      {
        id: "redaction-1",
        reason: "ignored-path",
        sourceKind: "note",
        createdAt: "2026-06-26T08:00:00.001Z",
      },
    ]);
    expect(serialized).not.toContain("Private/Secret.md");
    expect(serialized).not.toContain("private password");
    expect(serialized).not.toContain("abc123");
  });

  it("exports, persists, and reloads evidence ledgers through tool artifacts", async () => {
    const adapter = new MemoryAdapter();
    const store = new ToolArtifactStore(adapter.asDataAdapter(), ".obsidian/plugins/agentic-chat/artifacts", {
      now: () => FIXED_NOW,
    });
    let ledger = createEvidenceLedger({
      sessionId: "session-artifact",
      title: "Evidence export",
      now: () => FIXED_NOW,
    });
    const source = addEvidenceSource(ledger, { reference: "artifact:tool-imported" }, { now: () => FIXED_NOW + 1 });
    ledger = addEvidenceClaim(
      source.ledger,
      {
        text: "The imported artifact remains citable after reload.",
        sourceKeys: [source.sourceKey ?? ""],
      },
      { now: () => FIXED_NOW + 2 },
    );

    const metadata = await writeEvidenceLedgerArtifact(store, ledger);
    const reloaded = await readEvidenceLedgerArtifact(store, metadata.id);
    const parsed = parseEvidenceLedger(serializeEvidenceLedger(ledger));

    expect(metadata).toMatchObject({
      label: "Evidence ledger: Evidence export",
      sourceToolName: EVIDENCE_LEDGER_SOURCE_TOOL,
      contentType: EVIDENCE_LEDGER_CONTENT_TYPE,
    });
    expect(reloaded).toEqual(ledger);
    expect(parsed).toEqual(ledger);
  });

  it("rejects generated claims that reference unknown sources", () => {
    const ledger = createEvidenceLedger({ now: () => FIXED_NOW });

    expect(() =>
      addEvidenceClaim(ledger, { text: "Unsupported claim.", sourceKeys: ["note:missing.md"] }, { now: () => FIXED_NOW }),
    ).toThrow(/unknown sources/);
  });
});
