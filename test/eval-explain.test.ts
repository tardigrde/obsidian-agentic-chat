import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saturatedCases, type ToolUseBaseline } from "../scripts/eval/baseline-files";
import { explainRun, toolCallsFromTrace } from "../scripts/eval/explain";

const TRACE = [
  { type: "session" },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "Archive the invoice." }] } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "..." },
        { type: "toolCall", id: "c1", name: "vault_inspect", arguments: { path: "Inbox" } },
        { type: "toolCall", id: "c2", name: "move", arguments: { from: "Inbox/invoice.pdf", to: "Archive/invoice.pdf" } },
      ],
    },
  },
  { type: "message", message: { role: "toolResult", toolCallId: "c2", toolName: "move", isError: true, content: [] } },
]
  .map((line) => JSON.stringify(line))
  .join("\n");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "eval-explain-"));
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ cases: [{ id: "organize.easy.invoice", prompt: "Archive the invoice." }] }));
  writeFileSync(
    path.join(dir, "summary.json"),
    JSON.stringify({
      runId: "r1",
      model: "m",
      gitHead: "abcdef123",
      cases: [
        { id: "edit.easy.typo", runResults: [{ run: 1, status: "pass", checks: [] }] },
        {
          id: "organize.easy.invoice",
          runResults: [
            { run: 1, status: "pass", checks: [] },
            {
              run: 2,
              status: "fail",
              toolCalls: 2,
              usd: 0.0012,
              ms: 5_000,
              checks: [
                { type: "file_exists", ok: false, detail: "Archive/invoice.pdf is missing" },
                { type: "answer_contains", ok: true, detail: "ok" },
              ],
            },
          ],
        },
      ],
    }),
  );
  const caseDir = path.join(dir, "results", "organize.easy.invoice");
  mkdirSync(caseDir, { recursive: true });
  writeFileSync(path.join(caseDir, "2.json"), JSON.stringify({ observed: { answer: "Done, archived.", toolCalls: [] } }));
  writeFileSync(path.join(caseDir, "2.session.jsonl"), TRACE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("eval:explain (#393 T21)", () => {
  it("reads tool calls with arguments from the trace and marks an errored call", () => {
    expect(toolCallsFromTrace(TRACE)).toEqual([
      { name: "vault_inspect", args: '{"path":"Inbox"}', isError: false },
      { name: "move", args: '{"from":"Inbox/invoice.pdf","to":"Archive/invoice.pdf"}', isError: true },
    ]);
  });

  it("explains the first failing run on one page: prompt, calls with args, answer, check evidence", () => {
    const page = explainRun(dir);
    expect(page).toContain("# organize.easy.invoice run 2: fail");
    expect(page).toContain("head abcdef1; 2 tool call(s); $0.00120; 5.0s");
    expect(page).toContain("Archive the invoice.");
    expect(page).toContain('2. `move` (error) {"from":"Inbox/invoice.pdf","to":"Archive/invoice.pdf"}');
    expect(page).toContain("Done, archived.");
    expect(page).toContain("- FAIL file_exists: Archive/invoice.pdf is missing");
    expect(page).toContain("- pass answer_contains: ok");
  });

  it("explains a chosen run, and says when there is nothing to explain", () => {
    expect(explainRun(dir, { caseId: "edit.easy.typo", run: 1 })).toContain("# edit.easy.typo run 1: pass");
    expect(() => explainRun(dir, { caseId: "edit.easy.typo" })).toThrow("edit.easy.typo not found");
  });
});

describe("saturation flag", () => {
  const baseline = (ids: Record<string, number>, field = "passAllK") =>
    ({ cases: Object.entries(ids).map(([id, value]) => ({ id, [field]: value })) }) as unknown as ToolUseBaseline;

  it("lists cases at pass^k in the last 3 baselines, reading the old passAtK name too", () => {
    const history = [
      baseline({ a: 0, b: 0 }),
      baseline({ a: 1, b: 1, c: 1 }, "passAtK"),
      baseline({ a: 1, b: 0, c: 1 }),
      baseline({ a: 1, b: 1, c: 1 }),
    ];
    expect(saturatedCases(history)).toEqual(["a", "c"]);
    expect(saturatedCases(history.slice(0, 2))).toEqual([]);
  });
});
