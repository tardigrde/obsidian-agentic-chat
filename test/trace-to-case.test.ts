import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  parseDraftArgs,
  runTraceToCase,
  type MinedCaseDraft,
} from "../scripts/eval/trace-to-case";
import type { TraceCandidate } from "../scripts/eval/trace-miner";

const FIXED_NOW = new Date("2026-01-02T03:04:05.000Z");
const PROMPT_TODO = "TODO: restore the exact user prompt from the session; the candidate has no user turn.";
const TEMP_ROOTS: string[] = [];

const CANDIDATES: TraceCandidate[] = [
  {
    id: "trace-aaaa1111-1",
    session: "2026-01-02T03-04-05-000Z_fixture-a.jsonl",
    pluginVersion: "0.51.10",
    model: "openrouter/test-model",
    date: "2026-01-02",
    signal: "tool-error",
    severity: "high",
    userTurns: [{ text: "Fix the broken link in the [email] note.", images: 0 }],
    toolCalls: [{ name: "vault_read", isError: true }],
    evidence: "Tool vault_read returned an error: file not found at /[path]",
    replayHint:
      "Replay the user turn with vault_read stubbed to return this error; assert the assistant recovers without repeating the call.",
  },
  {
    id: "trace-bbbb2222-2",
    session: "2026-01-02T03-04-05-000Z_fixture-b.jsonl",
    signal: "user-correction",
    severity: "medium",
    userTurns: [
      { text: "Rename the note to Daily.", images: 0 },
      { text: "Undo the rename", images: 0 },
    ],
    toolCalls: [],
    evidence: 'User corrected the assistant: "Undo the rename"',
    replayHint: "Replay the earlier turn, then send this correction.",
  },
];

afterEach(async () => {
  for (const root of TEMP_ROOTS.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agentic-chat-trace-to-case-"));
  TEMP_ROOTS.push(root);
  return root;
}

async function writeCandidates(dir: string, candidates: unknown[]): Promise<string> {
  const file = path.join(dir, "candidates.json");
  await writeFile(file, `${JSON.stringify(candidates, null, 2)}\n`);
  return file;
}

async function readDraft(file: string): Promise<MinedCaseDraft> {
  return JSON.parse(await readFile(file, "utf8")) as MinedCaseDraft;
}

describe("runTraceToCase", () => {
  it("writes a draft with the redacted prompt, signal, and TODOs", async () => {
    const root = await tempDir();
    const candidateFile = await writeCandidates(root, CANDIDATES);

    const result = await runTraceToCase({
      candidateFile,
      id: "trace-aaaa1111-1",
      out: path.join(root, "out"),
      now: FIXED_NOW,
    });

    const draft = await readDraft(result.draftFile);
    expect(draft).toEqual({
      id: "mined.tool-error.fix-the-broken-link-in-the-email-note",
      prompt: "Fix the broken link in the [email] note.",
      seed: { vault: { size: "S", seed: 0 }, files: {} },
      checks: [],
      expected: { maxToolCalls: 20 },
      mined: {
        candidateId: "trace-aaaa1111-1",
        session: "2026-01-02T03-04-05-000Z_fixture-a.jsonl",
        signal: "tool-error",
        severity: "high",
        evidence: "Tool vault_read returned an error: file not found at /[path]",
        replayHint:
          "Replay the user turn with vault_read stubbed to return this error; assert the assistant recovers without repeating the call.",
        todos: [
          "choose or capture the vault",
          "restore the exact prompt",
          "write code-gradeable checks",
          "replay on main and keep only a real failure",
        ],
      },
    });

    const readme = await readFile(result.readmeFile, "utf8");
    expect(readme).toContain("mined.tool-error.fix-the-broken-link-in-the-email-note");
    expect(readme).toContain("file not found at /[path]");
    expect(readme).toContain("not a suite case");
    expect(readme).toContain("live model");
    for (const todo of draft.mined.todos) {
      expect(readme).toContain(todo);
    }
  });

  it("selects one candidate by id and uses its last user turn", async () => {
    const root = await tempDir();
    const candidateFile = await writeCandidates(root, CANDIDATES);

    const result = await runTraceToCase({
      candidateFile,
      id: "trace-bbbb2222-2",
      out: path.join(root, "out"),
      now: FIXED_NOW,
    });

    const draft = await readDraft(result.draftFile);
    expect(draft.prompt).toBe("Undo the rename");
    expect(draft.id).toBe("mined.user-correction.undo-the-rename");
    expect(draft.mined.candidateId).toBe("trace-bbbb2222-2");
    expect(draft.mined.signal).toBe("user-correction");
    expect(draft.mined.severity).toBe("medium");
    expect(draft).not.toHaveProperty("mined.userTurns");
    expect(JSON.stringify(draft)).not.toContain("Rename the note to Daily.");
  });

  it("fails and lists the available ids when the id is missing", async () => {
    const root = await tempDir();
    const candidateFile = await writeCandidates(root, CANDIDATES);

    await expect(
      runTraceToCase({ candidateFile, id: "trace-missing-9", out: path.join(root, "out") }),
    ).rejects.toThrow(
      'Candidate "trace-missing-9" not found. Available ids: trace-aaaa1111-1, trace-bbbb2222-2.',
    );
  });

  it("keeps only the redacted candidate fields and drops extra source fields", async () => {
    const root = await tempDir();
    const leaky = {
      ...CANDIDATES[0],
      secret: "sk-or-live-SECRET",
      rawSessionBody: "VAULT-BODY-MARKER",
    };
    const candidateFile = await writeCandidates(root, [leaky]);

    const result = await runTraceToCase({
      candidateFile,
      id: "trace-aaaa1111-1",
      out: path.join(root, "out"),
      now: FIXED_NOW,
    });

    const draft = await readDraft(result.draftFile);
    const readme = await readFile(result.readmeFile, "utf8");
    const surface = `${JSON.stringify(draft)}\n${readme}`;
    expect(surface).not.toContain("sk-or-live-SECRET");
    expect(surface).not.toContain("VAULT-BODY-MARKER");
    expect(draft.prompt).toBe("Fix the broken link in the [email] note.");
    expect(draft.mined.evidence).toBe(CANDIDATES[0].evidence);
    expect(draft.mined.replayHint).toBe(CANDIDATES[0].replayHint);
  });

  it("creates a missing output directory and writes valid JSON", async () => {
    const root = await tempDir();
    const candidateFile = await writeCandidates(root, CANDIDATES);
    const out = path.join(root, "nested", "eval-candidates");

    const result = await runTraceToCase({ candidateFile, id: "trace-aaaa1111-1", out, now: FIXED_NOW });

    expect(result.outDir).toBe(path.join(out, "trace-aaaa1111-1"));
    expect((await stat(result.outDir)).isDirectory()).toBe(true);
    expect(result.draftFile).toBe(path.join(out, "trace-aaaa1111-1", "case.draft.json"));
    expect(result.readmeFile).toBe(path.join(out, "trace-aaaa1111-1", "README.md"));
    const raw = await readFile(result.draftFile, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("uses the prompt TODO marker and falls back to the candidate id when there is no user turn", async () => {
    const root = await tempDir();
    const bare: TraceCandidate = {
      id: "trace-cccc3333-3",
      session: "2026-01-02T03-04-05-000Z_fixture-c.jsonl",
      signal: "long-chain",
      severity: "medium",
      userTurns: [],
      toolCalls: [],
      evidence: "21 tool calls in one user turn (limit 15)",
      replayHint: "Replay with a 15-call budget.",
    };
    const candidateFile = await writeCandidates(root, [bare]);

    const result = await runTraceToCase({
      candidateFile,
      id: "trace-cccc3333-3",
      out: path.join(root, "out"),
      now: FIXED_NOW,
    });

    const draft = await readDraft(result.draftFile);
    expect(draft.prompt).toBe(PROMPT_TODO);
    expect(draft.id).toBe("mined.long-chain.trace-cccc3333-3");
  });

  it("rejects a candidate id that is not a safe directory name", async () => {
    const root = await tempDir();
    const unsafe: TraceCandidate = { ...CANDIDATES[0]!, id: "../../escape" };
    const candidateFile = await writeCandidates(root, [unsafe]);

    await expect(
      runTraceToCase({ candidateFile, id: "../../escape", out: path.join(root, "out") }),
    ).rejects.toThrow('Candidate id "../../escape" is not a safe directory name.');
  });

  it("rejects a candidates file that is not an array", async () => {
    const root = await tempDir();
    const file = path.join(root, "candidates.json");
    await writeFile(file, `${JSON.stringify({ candidates: CANDIDATES }, null, 2)}\n`);

    await expect(
      runTraceToCase({ candidateFile: file, id: "trace-aaaa1111-1", out: path.join(root, "out") }),
    ).rejects.toThrow("candidates.json must be an array of trace candidates.");
  });

  it("accepts --sessions but does not read it in v1", async () => {
    const root = await tempDir();
    const candidateFile = await writeCandidates(root, CANDIDATES);

    const result = await runTraceToCase({
      candidateFile,
      id: "trace-aaaa1111-1",
      out: path.join(root, "out"),
      sessions: path.join(root, "no-such-sessions-dir"),
      now: FIXED_NOW,
    });

    expect(result.draft.mined.candidateId).toBe("trace-aaaa1111-1");
  });
});

describe("parseDraftArgs", () => {
  it("parses the candidate, id, output, and sessions options", () => {
    expect(
      parseDraftArgs([
        "--candidate",
        "candidates.json",
        "--id",
        "trace-aaaa1111-1",
        "--out",
        "logs/out",
        "--sessions",
        "sessions",
      ]),
    ).toEqual({
      candidate: "candidates.json",
      id: "trace-aaaa1111-1",
      out: "logs/out",
      sessions: "sessions",
      help: false,
    });
  });

  it("requires --candidate and --id", () => {
    expect(() => parseDraftArgs([])).toThrow("--candidate is required.");
    expect(() => parseDraftArgs(["--candidate", "candidates.json"])).toThrow("--id is required.");
    expect(() => parseDraftArgs(["--id", "trace-aaaa1111-1"])).toThrow("--candidate is required.");
  });

  it("prints help without the required options", () => {
    expect(parseDraftArgs(["--help"])).toEqual({ candidate: "", id: "", help: true });
  });
});
