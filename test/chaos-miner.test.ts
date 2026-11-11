import { describe, expect, it } from "vitest";
import {
  buildMinerDigest,
  condenseSessions,
  formatClock,
  isDraftWorthy,
  minerRawLog,
  parseMinerReply,
  parseMinerReport,
  renderFindingsMarkdown,
  renderIssueDraft,
  slugify,
  stepClock,
  type MinedFinding,
} from "../scripts/chaos/miner-core";

const session = [
  JSON.stringify({ type: "session", id: "s" }),
  JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "write a note" }] } }),
  JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "thinking", thinking: "hidden" }, { type: "toolCall", name: "write", arguments: { path: "A.md" } }],
    },
  }),
  JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "write", isError: true, content: [{ type: "text", text: "denied" }] } }),
  "broken line",
].join("\n");

const finding: MinedFinding = {
  title: "Stop leaves the composer disabled",
  severity: "S2",
  kind: "bug",
  confidence: "high",
  steps: ["x004"],
  expected: "composer is enabled",
  actual: "composer stays disabled",
  repro: ["send a prompt", "press stop"],
  evidence: ["errorPanels=1"],
};

describe("chaos miner digest", () => {
  it("maps explorer steps to video time", () => {
    const clock = stepClock([
      { t: 1.2, label: "chat open" },
      { t: 75.4, label: "x004 click" },
    ]);
    expect(clock.get("x004")).toBe(75.4);
    expect(formatClock(75.4)).toBe("01:15");
  });

  it("condenses session JSONL: text, tool calls, errors; hides thinking", () => {
    const text = condenseSessions([session], 10_000);
    expect(text).toContain("user: write a note");
    expect(text).toContain('[tool write {"path":"A.md"}]');
    expect(text).toContain("toolResult (tool=write ERROR): denied");
    expect(text).toContain("!! unparseable JSONL line");
    expect(text).not.toContain("hidden");
  });

  it("builds a bounded digest with steps, surprises, findings, and open issues", () => {
    const digest = buildMinerDigest({
      plan: { mode: "explore", live: true, model: "deepseek/deepseek-v4.1-flash", charter: "break settings" },
      driver: { verdict: "FINDINGS", stopReason: "explorer-done", findings: [{ severity: "S2", step: "x004", message: "[oracle:error] boom" }] },
      actions: [
        { step: "x004", status: "passed", description: "click Stop", detail: "clicked", expect: "turn stops", previous: "surprising", surprise: "still running", errors: ["w0 uncaught: boom"] },
      ],
      timeline: [{ t: 75.4, label: "x004 click" }],
      sessions: ["x".repeat(400_000)],
      openIssues: [{ number: 12, title: "chaos: old bug" }],
      maxChars: 50_000,
    });
    expect(digest).toContain("x004 [video 01:15] passed: click Stop -> clicked");
    expect(digest).toContain("SURPRISING: still running");
    expect(digest).toContain("#12 chaos: old bug");
    expect(digest).toContain("S2 x004: [oracle:error] boom");
    expect(digest.length).toBeLessThan(80_000);
  });
});

describe("chaos miner report", () => {
  it("normalizes the model reply and sorts by severity", () => {
    const report = parseMinerReport({
      summary: "ok",
      findings: [
        { title: "cosmetic", severity: "s4", kind: "ux", confidence: "high" },
        { title: "crash", severity: "S1", kind: "weird", confidence: "sure", duplicate_of: 7 },
        { title: "" },
      ],
    });
    expect(report.findings.map((item) => [item.title, item.severity, item.kind, item.confidence, item.duplicateOf])).toEqual([
      ["crash", "S1", "bug", "medium", 7],
      ["cosmetic", "S4", "ux", "high", undefined],
    ]);
  });

  it("drafts only confident, new product findings", () => {
    expect(isDraftWorthy(finding)).toBe(true);
    expect(isDraftWorthy({ ...finding, confidence: "low" })).toBe(false);
    expect(isDraftWorthy({ ...finding, kind: "harness" })).toBe(false);
    expect(isDraftWorthy({ ...finding, duplicateOf: 3 })).toBe(false);
  });

  it("renders an issue draft with repro, clip time, and the replay command", () => {
    const clock = new Map([["x004", 75.4]]);
    const draft = renderIssueDraft(finding, { runDir: "logs/chaos/run1", model: "deepseek/deepseek-v4.1-flash", clock });
    expect(draft.title).toBe("chaos: Stop leaves the composer disabled");
    expect(draft.body).toContain("1. send a prompt\n2. press stop");
    expect(draft.body).toContain("x004 at 01:15");
    expect(draft.body).toContain("--replay logs/chaos/run1/explorer-decisions.jsonl");
    const markdown = renderFindingsMarkdown({ summary: "s", coverage: ["chat"], gaps: [], findings: [finding] }, { runDir: "logs/chaos/run1", model: "m", clock }, ["01-stop.md"]);
    expect(markdown).toContain("| 1 | S2 | bug | high | Stop leaves the composer disabled | x004 | 01:15 |");
    expect(markdown).toContain("`issues/01-stop.md`");
    expect(slugify("Stop: leaves (the) composer!")).toBe("stop-leaves-the-composer");
  });
});

describe("chaos miner reply parsing", () => {
  it("reads a fenced or bare report", () => {
    const body = '{"summary":"ok","findings":[{"title":"t","severity":"S2","kind":"bug","confidence":"high"}]}';
    for (const text of [body, `Here it is:\n\`\`\`json\n${body}\n\`\`\``]) {
      const parsed = parseMinerReply(text);
      expect(parsed.ok && parsed.report.findings[0].title).toBe("t");
    }
  });

  it("returns an error, not a throw, for empty, cut-off, or broken replies", () => {
    expect(parseMinerReply("")).toEqual({ ok: false, error: "reply was empty" });
    expect(parseMinerReply('{"summary":"ok","findings":[{"title":"cut')).toEqual({
      ok: false,
      error: "reply had no complete JSON object",
    });
    const broken = parseMinerReply("{summary: ok}");
    expect(broken.ok).toBe(false);
  });

  it("logs why a reply failed and how it ended", () => {
    const log = minerRawLog({ text: "{", finishReason: "length", model: "m" }, "reply had no complete JSON object");
    expect(log).toContain("finish_reason: length");
    expect(log).toContain("error: reply had no complete JSON object");
  });
});
