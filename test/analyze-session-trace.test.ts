import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const tempRoots: string[] = [];

afterEach(async () => {
  for (const root of tempRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agentic-chat-analyze-"));
  tempRoots.push(root);
  return root;
}

async function writeJsonl(file: string, entries: unknown[]): Promise<void> {
  await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

async function loadAnalyzer(): Promise<{
  analyzePath: (target: string) => {
    files: Array<{
      noteMutations: Array<{ key: string; count: number }>;
      repeatedActiveNoteBodies?: Array<{ key: string; count: number; chars: number }>;
      turns?: Array<{
        activeNote: string;
        cacheHits: number;
        repeatedExternalPathActions: Array<{ key: string; count: number }>;
        duplicateToolStarts: Array<{ key: string; count: number }>;
        approvalDenialReasons: Array<{ key: string; count: number }>;
        usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
      }>;
    }>;
    aggregate: {
      toolStarts?: number;
      toolStartsByTool?: Record<string, number>;
      toolErrorsByTool?: Record<string, number>;
      cacheHits?: number;
      repeatedActiveNoteBodies?: Array<{ key: string; count: number; chars: number }>;
      repeatedExternalPathActions?: Array<{ key: string; count: number }>;
      duplicateToolStarts?: Array<{ key: string; count: number }>;
      approvalDenialReasons?: Array<{ key: string; count: number }>;
    };
  };
  compareAnalyses: (
    before: unknown,
    after: unknown,
  ) => {
    metrics: Array<{ key: string; before: number; after: number; delta: number }>;
    repeatedExternalPathActions: Array<{ key: string; before: number; after: number; delta: number }>;
  };
  formatAnalysisMarkdown: (analysis: unknown) => string;
  formatComparisonMarkdown: (comparison: unknown) => string;
}> {
  return import(pathToFileURL(path.join(process.cwd(), "scripts/analyze-session-trace.mjs")).href) as Promise<{
    analyzePath: (target: string) => {
      files: Array<{
        noteMutations: Array<{ key: string; count: number }>;
        repeatedActiveNoteBodies?: Array<{ key: string; count: number; chars: number }>;
        turns?: Array<{
          activeNote: string;
          cacheHits: number;
          repeatedExternalPathActions: Array<{ key: string; count: number }>;
          duplicateToolStarts: Array<{ key: string; count: number }>;
          approvalDenialReasons: Array<{ key: string; count: number }>;
          usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number };
        }>;
      }>;
      aggregate: {
        cacheHits?: number;
        repeatedActiveNoteBodies?: Array<{ key: string; count: number; chars: number }>;
        repeatedExternalPathActions?: Array<{ key: string; count: number }>;
        duplicateToolStarts?: Array<{ key: string; count: number }>;
        approvalDenialReasons?: Array<{ key: string; count: number }>;
      };
    };
    compareAnalyses: (
      before: unknown,
      after: unknown,
    ) => {
      metrics: Array<{ key: string; before: number; after: number; delta: number }>;
      repeatedExternalPathActions: Array<{ key: string; before: number; after: number; delta: number }>;
    };
    formatAnalysisMarkdown: (analysis: unknown) => string;
    formatComparisonMarkdown: (comparison: unknown) => string;
  }>;
}

describe("analyze-session-trace", () => {
  it("keeps different mutating tools separate when they share a diff kind", async () => {
    const root = await tempDir();
    const file = path.join(root, "session.jsonl");
    const entries = [
      {
        type: "action_audit",
        event: {
          category: "tool_call",
          action: "start",
          toolName: "set_properties",
          diff: { kind: "edit", path: "Note.md" },
        },
      },
      {
        type: "action_audit",
        event: {
          category: "approval",
          action: "decision",
          decision: "auto-approved",
          toolName: "set_properties",
          diff: { kind: "edit", path: "Note.md" },
        },
      },
      {
        type: "action_audit",
        event: {
          category: "approval",
          action: "decision",
          decision: "auto-approved",
          toolName: "edit",
          diff: { kind: "edit", path: "Note.md" },
        },
      },
    ];
    await writeJsonl(file, entries);

    const analyzer = await loadAnalyzer();
    const result = analyzer.analyzePath(file);

    expect(result.files[0].noteMutations).toEqual(
      expect.arrayContaining([
        { key: "set_properties Note.md", count: 1 },
        { key: "edit Note.md", count: 1 },
      ]),
    );
    expect(result.files[0].noteMutations).not.toContainEqual({ key: "edit Note.md", count: 2 });
  });

  it("summarizes turn-level cache, repeated external calls, approvals, and usage", async () => {
    const root = await tempDir();
    const file = path.join(root, "session.jsonl");
    await writeJsonl(file, [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: 'Active note "Root.md"\nInspect the workspace.' }],
        },
      },
      {
        type: "action_audit",
        event: {
          category: "tool_call",
          action: "start",
          toolName: "external_inspect",
          toolCallId: "ext-1",
          args: { action: "read", path: "repos/service-a/package.json" },
        },
      },
      {
        type: "action_audit",
        event: {
          category: "tool_call",
          action: "start",
          toolName: "external_inspect",
          toolCallId: "ext-2",
          args: { action: "read", path: "repos/service-a/package.json" },
        },
      },
      { type: "message", message: { role: "toolResult", toolCallId: "ext-2", details: { cached: true } } },
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 155 },
        },
      },
      {
        type: "action_audit",
        event: {
          category: "approval",
          action: "decision",
          decision: "denied",
          toolName: "write",
          toolCallId: "write-1",
          reason: "manual test denial",
          diff: { kind: "write", path: "Generated/Plan.md" },
        },
      },
    ]);

    const analyzer = await loadAnalyzer();
    const result = analyzer.analyzePath(file);
    const turn = result.files[0].turns?.[0];

    expect(result.aggregate.cacheHits).toBe(1);
    expect(result.aggregate.repeatedExternalPathActions).toContainEqual({
      key: "read repos/service-a/package.json",
      count: 2,
    });
    expect(turn).toMatchObject({
      activeNote: "Root.md",
      cacheHits: 1,
      usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, totalTokens: 155 },
    });
    expect(turn?.repeatedExternalPathActions).toContainEqual({ key: "read repos/service-a/package.json", count: 2 });
    expect(turn?.duplicateToolStarts[0]?.count).toBe(2);
    expect(turn?.approvalDenialReasons).toContainEqual({ key: "write: manual test denial", count: 1 });

    const markdown = analyzer.formatAnalysisMarkdown(result);
    expect(markdown).toContain("Cache hits");
    expect(markdown).toContain("read repos/service-a/package.json");
    expect(markdown).toContain("Turns With Signals");
  });

  it("counts assistant tool-call records when audit starts were compacted away", async () => {
    const root = await tempDir();
    const file = path.join(root, "session.jsonl");
    await writeJsonl(file, [
      {
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Compare these files." }],
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "ext-1",
              name: "external_inspect",
              arguments: { action: "read", path: "repos/service-a/package.json" },
            },
            {
              type: "toolCall",
              id: "ext-2",
              name: "external_inspect",
              arguments: { action: "read", path: "repos/service-a/package.json" },
            },
          ],
        },
      },
    ]);

    const analyzer = await loadAnalyzer();
    const result = analyzer.analyzePath(file);

    expect(result.aggregate.toolStarts).toBe(2);
    expect(result.aggregate.toolStartsByTool?.external_inspect).toBe(2);
    expect(result.aggregate.repeatedExternalPathActions).toContainEqual({
      key: "read repos/service-a/package.json",
      count: 2,
    });
  });

  it("reports repeated inline active-note bodies without counting unchanged references", async () => {
    const root = await tempDir();
    const file = path.join(root, "session.jsonl");
    const inlineContext =
      '<context>\nThe user attached the following from their vault:\n\nActive note "Iac.md":\n\nstable body\n</context>\n\n';
    await writeJsonl(file, [
      { type: "message", message: { role: "user", content: [{ type: "text", text: `${inlineContext}First turn.` }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: `${inlineContext}Second turn.` }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text:
                '<context>\nThe user attached the following from their vault:\n\nActive note "Iac.md" is unchanged since it was already attached earlier in this session. Use the read tool to open it if you need the full content.\n</context>\n\nThird turn.',
            },
          ],
        },
      },
    ]);

    const analyzer = await loadAnalyzer();
    const result = analyzer.analyzePath(file);

    expect(result.files[0].repeatedActiveNoteBodies).toContainEqual({ key: "Iac.md", count: 2, chars: 11 });
    expect(result.aggregate.repeatedActiveNoteBodies).toContainEqual({ key: "Iac.md", count: 2, chars: 11 });
    expect(analyzer.formatAnalysisMarkdown(result)).toContain("Repeated Active Note Bodies");
  });

  it("compares before and after trace snapshots", async () => {
    const root = await tempDir();
    const beforeFile = path.join(root, "before.jsonl");
    const afterFile = path.join(root, "after.jsonl");
    await writeJsonl(beforeFile, [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: 'Active note "Root.md"\nStart.' }] },
      },
      {
        type: "action_audit",
        event: {
          category: "tool_call",
          action: "start",
          toolName: "external_inspect",
          toolCallId: "ext-1",
          args: { action: "read", path: "repos/service-a/package.json" },
        },
      },
    ]);
    await writeJsonl(afterFile, [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: 'Active note "Root.md"\nStart.' }] },
      },
      {
        type: "action_audit",
        event: {
          category: "tool_call",
          action: "start",
          toolName: "external_inspect",
          toolCallId: "ext-1",
          args: { action: "read", path: "repos/service-a/package.json" },
        },
      },
      {
        type: "action_audit",
        event: {
          category: "tool_call",
          action: "start",
          toolName: "external_inspect",
          toolCallId: "ext-2",
          args: { action: "read", path: "repos/service-a/package.json" },
        },
      },
      { type: "message", message: { role: "toolResult", toolCallId: "ext-2", details: { cached: true } } },
    ]);

    const analyzer = await loadAnalyzer();
    const comparison = analyzer.compareAnalyses(analyzer.analyzePath(beforeFile), analyzer.analyzePath(afterFile));

    expect(comparison.metrics).toContainEqual({ key: "externalInspectStarts", before: 1, after: 2, delta: 1 });
    expect(comparison.metrics).toContainEqual({ key: "cacheHits", before: 0, after: 1, delta: 1 });
    expect(comparison.repeatedExternalPathActions).toContainEqual({
      key: "read repos/service-a/package.json",
      before: 0,
      after: 2,
      delta: 2,
    });
    expect(analyzer.formatComparisonMarkdown(comparison)).toContain("Session Trace Comparison");
  });
});
