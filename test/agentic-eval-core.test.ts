import { describe, expect, it } from "vitest";
import {
  evaluateScriptedDogfoodCase,
  evaluateStaticContextCase,
  validateEvalSuite,
  type ScriptedDogfoodEvalCase,
  type ScriptedDogfoodSnapshot,
  type StaticContextEvalCase,
  type StaticContextSnapshot,
} from "../scripts/agentic-eval-core";

describe("agentic eval core", () => {
  it("rejects duplicate case ids", () => {
    expect(() =>
      validateEvalSuite({
        version: 1,
        name: "duplicate-suite",
        cases: [
          { id: "same", type: "static-context", assertions: [] },
          { id: "same", type: "static-context", assertions: [] },
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
            type: "static-context",
            assertions: [{ type: "unknown_assertion" }],
          },
        ],
      }),
    ).toThrow("Unsupported assertion type");
  });

  it("reports prompt references to unavailable tools", () => {
    const evalCase: StaticContextEvalCase = {
      id: "static",
      type: "static-context",
      assertions: [
        {
          type: "prompt_mentions_only_registered_tools",
          names: ["read", "search", "ls"],
          severity: "error",
        },
      ],
    };
    const snapshot: StaticContextSnapshot = {
      systemPrompt: "Use read, search, and ls proactively.",
      userPrompt: "",
      contextChars: 100,
      toolSchemaTokens: 20,
      knownToolNames: ["read", "search", "ls"],
      tools: [{ name: "read", description: "Read a file." }],
    };

    const result = evaluateStaticContextCase(evalCase, snapshot);

    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: "error",
        area: "prompt-tools",
        message: "System prompt mentions unavailable tool(s): search, ls.",
      }),
    ]);
  });

  it("reports missing tool-description guidance", () => {
    const evalCase: StaticContextEvalCase = {
      id: "descriptions",
      type: "static-context",
      assertions: [
        {
          type: "tool_description_contains",
          name: "write",
          text: "frontmatter",
          severity: "warning",
        },
      ],
    };
    const snapshot: StaticContextSnapshot = {
      systemPrompt: "",
      userPrompt: "",
      contextChars: 100,
      toolSchemaTokens: 20,
      knownToolNames: ["write"],
      tools: [{ name: "write", description: "Create or overwrite a vault-relative file." }],
    };

    const result = evaluateStaticContextCase(evalCase, snapshot);

    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        area: "tool-description",
        message: "Tool write description does not contain: frontmatter",
      }),
    ]);
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
