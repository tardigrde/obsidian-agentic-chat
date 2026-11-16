/**
 * Turn one `trace:mine` candidate into a draft eval case for human review.
 *
 * Local only: this module never calls a model, opens a socket, or reads a
 * session file. Input is the redacted `candidates.json` that
 * `scripts/eval/trace-miner.ts` writes. Output is a scaffold with an empty
 * `checks` array, so the tool-use runner cannot score it until a person fills
 * the TODOs and replays it on `main` with a live model.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { TraceCandidate, TraceSeverity } from "./trace-miner";
import { displayPath, parseStringOptions, runCli, timestampSlug } from "./trace-utils";

export interface MinedCaseDraft {
  id: string;
  prompt: string;
  seed: { vault: { size: "S"; seed: number }; files: Record<string, string> };
  /** Empty on purpose: a draft is not a suite case. */
  checks: [];
  expected: { maxToolCalls: number };
  mined: {
    candidateId: string;
    session: string;
    signal: string;
    severity: TraceSeverity;
    evidence: string;
    replayHint: string;
    todos: string[];
  };
}

export interface CaseDraftOptions {
  /** Path to the `candidates.json` that `trace:mine` wrote. */
  candidateFile: string;
  /** Candidate id to convert. */
  id: string;
  /** Base output directory; the candidate id becomes a subdirectory. */
  out?: string;
  now?: Date;
}

export interface DraftArgs {
  candidate: string;
  id: string;
  out?: string;
  help: boolean;
}

export interface CaseDraftOutput {
  candidate: TraceCandidate;
  draft: MinedCaseDraft;
  outDir: string;
  draftFile: string;
  readmeFile: string;
}

const PROMPT_TODO = "TODO: restore the exact user prompt from the session; the candidate has no user turn.";
const DRAFT_TODOS = [
  "choose or capture the vault",
  "restore the exact prompt",
  "write code-gradeable checks",
  "replay on main and keep only a real failure",
] as const;
const DEFAULT_MAX_TOOL_CALLS = 20;
const MAX_SLUG_WORDS = 8;
const MAX_SLUG_CHARS = 48;
const REQUIRED_STRING_FIELDS = ["id", "session", "signal", "evidence", "replayHint"] as const;
const SEVERITIES: ReadonlySet<TraceSeverity> = new Set<TraceSeverity>(["high", "medium", "low"]);
const SAFE_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Read the candidate array that `trace:mine` writes, and check its shape. */
function parseCandidates(text: string): TraceCandidate[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("candidates.json must be an array of trace candidates.");
  return parsed.map((value, index) => toCandidate(value, index));
}

/** Select exactly one candidate; a miss names the ids that are available. */
function selectCandidate(candidates: TraceCandidate[], id: string): TraceCandidate {
  const found = candidates.find((candidate) => candidate.id === id);
  if (found) return found;
  const available = candidates.map((candidate) => candidate.id).join(", ") || "(none)";
  throw new Error(`Candidate "${id}" not found. Available ids: ${available}.`);
}

/** Build the draft scaffold. Every value is a copy of a redacted candidate field. */
function buildCaseDraft(candidate: TraceCandidate): MinedCaseDraft {
  const prompt = lastUserPrompt(candidate);
  return {
    id: `mined.${candidate.signal}.${draftSlug(prompt ?? candidate.id)}`,
    prompt: prompt ?? PROMPT_TODO,
    seed: { vault: { size: "S", seed: 0 }, files: {} },
    checks: [],
    expected: { maxToolCalls: DEFAULT_MAX_TOOL_CALLS },
    mined: {
      candidateId: candidate.id,
      session: candidate.session,
      signal: candidate.signal,
      severity: candidate.severity,
      evidence: candidate.evidence,
      replayHint: candidate.replayHint,
      todos: [...DRAFT_TODOS],
    },
  };
}

/** One draft directory per candidate: `case.draft.json` plus this guide. */
function renderDraftReadme(draft: MinedCaseDraft): string {
  return [
    `# Draft eval case \`${draft.id}\``,
    "",
    "This is a scaffold, not a suite case. `checks` is empty, so the tool-use",
    "runner cannot score it. Do not commit it under `test/evals/`. Promote it",
    "only after a live replay shows a real failure and the checks are fair.",
    "",
    `- Candidate: \`${draft.mined.candidateId}\``,
    `- Session: \`${draft.mined.session}\``,
    `- Signal: \`${draft.mined.signal}\` (${draft.mined.severity})`,
    "",
    "## Draft prompt",
    "",
    "```text",
    draft.prompt,
    "```",
    "",
    "A candidate keeps only the redacted, truncated last user turn. If the text",
    "above is a TODO marker, the candidate has no user turn.",
    "",
    "## Evidence (redacted)",
    "",
    `> ${draft.mined.evidence}`,
    "",
    `Replay hint: ${draft.mined.replayHint}`,
    "",
    "## TODOs",
    "",
    "- [ ] **choose or capture the vault.** The draft keeps the placeholder",
    '  `{"vault":{"size":"S","seed":0},"files":{}}`. Replace it with the vault',
    "  that reproduces the failure, or list the `seed.files` notes it needs.",
    "- [ ] **restore the exact prompt.** Read the session with its owner's",
    "  consent and paste the exact prompt. Redaction and truncation can change",
    "  the request.",
    "- [ ] **write code-gradeable checks.** Add checks such as `answer_contains`,",
    "  `unchanged`, `file_exists`, `tool_not_called`, and `max_tool_calls`. A",
    "  check must fail on the old behavior and pass after the fix.",
    "- [ ] **replay on main and keep only a real failure.** Run the live eval on",
    "  current `main`. If the case passes, delete the draft; a passing case is",
    "  not a regression.",
    "",
    "## Replay needs a live model",
    "",
    "The replay calls a real model with an API key. It is not part of",
    "`npm run verify -- fast`, CI does not run it, and this converter never",
    "calls a model.",
    "",
    "This converter reads only `candidates.json`. It never opens a session file.",
    "",
  ].join("\n");
}

export function parseDraftArgs(argv: string[]): DraftArgs {
  const { values, help } = parseStringOptions(argv, ["candidate", "id", "out"]);
  if (!help) {
    if (!values.candidate) throw new Error("--candidate is required.");
    if (!values.id) throw new Error("--id is required.");
  }
  return { candidate: values.candidate ?? "", id: values.id ?? "", out: values.out, help };
}

export async function runTraceToCase(options: CaseDraftOptions): Promise<CaseDraftOutput> {
  const candidates = parseCandidates(await readFile(options.candidateFile, "utf8")); // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
  const candidate = selectCandidate(candidates, options.id);
  assertSafeDirName(candidate.id);
  const base = options.out ?? path.join("logs", "eval-candidates", timestampSlug(options.now ?? new Date()));
  const outDir = path.resolve(base, candidate.id);
  const draft = buildCaseDraft(candidate);
  await mkdir(outDir, { recursive: true }); // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
  const draftFile = path.join(outDir, "case.draft.json");
  const readmeFile = path.join(outDir, "README.md");
  await writeFile(draftFile, `${JSON.stringify(draft, null, 2)}\n`); // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
  await writeFile(readmeFile, renderDraftReadme(draft)); // NOSONAR:S8707 -- local dev CLI: the path is the developer's own argument on their own machine.
  return { candidate, draft, outDir, draftFile, readmeFile };
}

function toCandidate(value: unknown, index: number): TraceCandidate {
  if (!isRecord(value)) throw badCandidate(index, "an object");
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof value[field] !== "string") throw badCandidate(index, `a string "${field}"`);
  }
  if (!SEVERITIES.has(value.severity as TraceSeverity)) {
    throw badCandidate(index, 'a severity of "high", "medium", or "low"');
  }
  if (!Array.isArray(value.userTurns) || !Array.isArray(value.toolCalls)) {
    throw badCandidate(index, "userTurns and toolCalls arrays");
  }
  return value as unknown as TraceCandidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badCandidate(index: number, expected: string): Error {
  return new Error(`Invalid candidate at index ${index}: expected ${expected}.`);
}

function lastUserPrompt(candidate: TraceCandidate): string | undefined {
  for (let index = candidate.userTurns.length - 1; index >= 0; index -= 1) {
    const text = candidate.userTurns[index]?.text;
    if (typeof text === "string" && text.trim()) return text;
  }
  return undefined;
}

function draftSlug(source: string): string {
  const words = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean)
    .slice(0, MAX_SLUG_WORDS);
  // Words are joined with single hyphens, so a cut leaves at most one trailing hyphen.
  const slug = words.join("-").slice(0, MAX_SLUG_CHARS).replace(/-$/, "");
  return slug || "untitled";
}

/** A candidate id becomes a directory name, so a path segment cannot escape. */
function assertSafeDirName(id: string): void {
  if (!SAFE_DIR_NAME.test(id) || id.includes("..")) {
    throw new Error(`Candidate id "${id}" is not a safe directory name.`);
  }
}

function usageText(): string {
  return [
    "Usage:",
    "  npm run eval:from-trace -- --candidate <candidates.json> --id <candidate-id> [--out <dir>]",
    "",
    "Writes <out>/<id>/case.draft.json and README.md for one trace candidate.",
    "Default output: logs/eval-candidates/<timestamp>/<id>/",
    "",
    "The draft has empty checks and is not a suite case. A live replay is required.",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseDraftArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usageText()}\n`);
    return;
  }
  const result = await runTraceToCase({
    candidateFile: args.candidate,
    id: args.id,
    out: args.out,
  });
  process.stdout.write(
    `[eval:from-trace] candidate: ${result.candidate.id} (${result.candidate.signal}, ${result.candidate.severity})\n`,
  );
  process.stdout.write(`[eval:from-trace] draft: ${displayPath(result.draftFile)}\n`);
  process.stdout.write(`[eval:from-trace] readme: ${displayPath(result.readmeFile)}\n`);
  process.stdout.write(
    "[eval:from-trace] checks are empty: this is a draft, not a suite case. A live replay is required.\n",
  );
}

runCli(import.meta.url, "eval:from-trace", main);
