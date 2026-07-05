import { describe, expect, it } from "vitest";
import { compareEvalSummaries, formatEvalComparisonMarkdown } from "../scripts/compare-agentic-evals";

describe("agentic eval comparison", () => {
  it("reports finding and metric regressions between eval runs", () => {
    const comparison = compareEvalSummaries(
      {
        runId: "baseline",
        suite: { name: "agentic-chat" },
        results: [
          {
            id: "static.default-context",
            type: "static-context",
            status: "pass",
            findings: [],
            metrics: { contextChars: 4200, toolSchemaTokens: 950 },
          },
          {
            id: "dogfood.scripted",
            type: "scripted-dogfood",
            status: "pass",
            findings: [],
            metrics: {
              maxUserMessageChars: 1200,
              repeatedExternalPathActions: [{ key: "read repos/service-a/package.json", count: 1 }],
              duplicateToolStarts: [],
              toolErrors: { write: 0 },
              cacheHits: 1,
            },
          },
        ],
      },
      {
        runId: "candidate",
        suite: { name: "agentic-chat" },
        results: [
          {
            id: "static.default-context",
            type: "static-context",
            status: "problem",
            findings: [{ severity: "warning", area: "context-budget", message: "prompt grew" }],
            metrics: { contextChars: 5300, toolSchemaTokens: 1250 },
          },
          {
            id: "dogfood.scripted",
            type: "scripted-dogfood",
            status: "pass",
            findings: [],
            metrics: {
              maxUserMessageChars: 1500,
              repeatedExternalPathActions: [{ key: "read repos/service-a/package.json", count: 3 }],
              duplicateToolStarts: [{ key: "external_inspect {}", count: 2 }],
              toolErrors: { write: 1 },
              cacheHits: 0,
            },
          },
        ],
      },
      () => new Date("2026-07-01T00:00:00.000Z"),
    );

    expect(comparison.totals.delta).toEqual({ errors: 0, warnings: 1, total: 1 });
    expect(comparison.regressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ caseId: "static.default-context", area: "status" }),
        expect.objectContaining({ caseId: "static.default-context", message: "Candidate adds 1 warning finding(s)." }),
        expect.objectContaining({ caseId: "static.default-context", message: "contextChars: 4200 -> 5300 (+1100)" }),
        expect.objectContaining({ caseId: "dogfood.scripted", message: "cacheHits: 1 -> 0 (-1)" }),
        expect.objectContaining({
          caseId: "dogfood.scripted",
          message: "repeatedExternalPathActions.countTotal: 1 -> 3 (+2)",
        }),
      ]),
    );
    expect(formatEvalComparisonMarkdown(comparison)).toContain("Agentic Eval Comparison");
  });

  it("reports prompt and dogfood improvements", () => {
    const comparison = compareEvalSummaries(
      {
        runId: "baseline",
        suite: { name: "agentic-chat" },
        results: [
          {
            id: "dogfood.scripted",
            type: "scripted-dogfood",
            status: "problem",
            findings: [
              { severity: "warning", area: "tool-efficiency", message: "duplicate" },
              { severity: "warning", area: "tool-errors", message: "error" },
            ],
            metrics: {
              maxUserMessageChars: 2500,
              repeatedExternalPathActions: [{ key: "read a", count: 4 }],
              cacheHits: 0,
            },
          },
        ],
      },
      {
        runId: "candidate",
        suite: { name: "agentic-chat" },
        results: [
          {
            id: "dogfood.scripted",
            type: "scripted-dogfood",
            status: "pass",
            findings: [],
            metrics: {
              maxUserMessageChars: 1800,
              repeatedExternalPathActions: [{ key: "read a", count: 1 }],
              cacheHits: 2,
            },
          },
        ],
      },
      () => new Date("2026-07-01T00:00:00.000Z"),
    );

    expect(comparison.improvements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ caseId: "dogfood.scripted", area: "status" }),
        expect.objectContaining({ caseId: "dogfood.scripted", message: "Candidate removes 2 warning finding(s)." }),
        expect.objectContaining({ caseId: "dogfood.scripted", message: "maxUserMessageChars: 2500 -> 1800 (-700)" }),
        expect.objectContaining({ caseId: "dogfood.scripted", message: "cacheHits: 0 -> 2 (+2)" }),
      ]),
    );
    expect(comparison.regressions).toEqual([]);
  });
});
