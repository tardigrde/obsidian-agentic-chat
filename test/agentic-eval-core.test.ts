import { describe, expect, it } from "vitest";
import {
  evaluateScriptedDogfoodCase,
  validateEvalSuite,
  type ScriptedDogfoodEvalCase,
  type ScriptedDogfoodSnapshot,
} from "../scripts/agentic-eval-core";

describe("agentic eval core", () => {
  it("rejects duplicate case ids", () => {
    expect(() =>
      validateEvalSuite({
        version: 1,
        name: "duplicate-suite",
        cases: [
          { id: "same", type: "scripted-dogfood", assertions: [] },
          { id: "same", type: "scripted-dogfood", assertions: [] },
        ],
      }),
    ).toThrow("Duplicate eval case id: same");
  });

  it("rejects unknown assertion types", () => {
    expect(() =>
      validateEvalSuite({
        version: 1,
        name: "bad-assertion-suite",
        cases: [
          {
            id: "case",
            type: "scripted-dogfood",
            assertions: [{ type: "unknown_assertion" }],
          },
        ],
      }),
    ).toThrow("Unsupported assertion type");
  });

  it("rejects the retired static-context and llm-judge case types", () => {
    for (const type of ["static-context", "llm-judge"]) {
      expect(() => validateEvalSuite({ version: 1, name: "retired", cases: [{ id: "old", type, assertions: [] }] })).toThrow(
        `Unsupported eval case type for old: ${type}`,
      );
    }
  });

  it("reports repeated exact dogfood tool actions", () => {
    const evalCase: ScriptedDogfoodEvalCase = {
      id: "dogfood",
      type: "scripted-dogfood",
      assertions: [
        {
          type: "max_repeated_external_path_action",
          max: 1,
          severity: "warning",
        },
        {
          type: "max_duplicate_tool_starts",
          max: 1,
          severity: "warning",
        },
      ],
    };
    const snapshot: ScriptedDogfoodSnapshot = {
      invariant: {
        ok: true,
        findings: [],
        metrics: { maxUserMessageChars: 100, toolStarts: {}, toolErrors: {} },
      },
      trace: {
        files: [
          {
            repeatedExternalPathActions: [{ key: "read foreign-vault/Imported.md", count: 2 }],
            duplicateToolStarts: [{ key: "external_inspect {\"action\":\"read\"}", count: 2 }],
          },
        ],
      },
    };

    const result = evaluateScriptedDogfoodCase(evalCase, snapshot);

    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((finding) => finding.area)).toEqual(["tool-efficiency", "tool-efficiency"]);
  });

  it("allows intentional dogfood sad-path noise while preserving unexpected checks", () => {
    const evalCase: ScriptedDogfoodEvalCase = {
      id: "dogfood",
      type: "scripted-dogfood",
      assertions: [
        {
          type: "max_tool_errors",
          max: 0,
          severity: "warning",
          allowedByTool: { write: 4 },
        },
        {
          type: "max_repeated_external_path_action",
          max: 1,
          severity: "warning",
          allowedKeys: ["read foreign-vault/Imported.md"],
        },
        {
          type: "max_duplicate_tool_starts",
          max: 1,
          severity: "warning",
          allowedKeys: ["external_inspect {\"action\":\"read\",\"path\":\"foreign-vault/Imported.md\"}"],
        },
      ],
    };
    const snapshot: ScriptedDogfoodSnapshot = {
      invariant: {
        ok: true,
        findings: [],
        metrics: { maxUserMessageChars: 100, toolStarts: {}, toolErrors: { write: 4 } },
      },
      trace: {
        files: [
          {
            repeatedExternalPathActions: [{ key: "read foreign-vault/Imported.md", count: 3 }],
            duplicateToolStarts: [
              { key: "external_inspect {\"action\":\"read\",\"path\":\"foreign-vault/Imported.md\"}", count: 3 },
            ],
          },
        ],
      },
    };

    const result = evaluateScriptedDogfoodCase(evalCase, snapshot);

    expect(result.findings).toEqual([]);
  });
});
