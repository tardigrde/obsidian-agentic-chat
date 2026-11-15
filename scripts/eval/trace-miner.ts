/**
 * Mine session JSONL into anonymized failure candidates for the eval loop.
 *
 * Local only: this module never calls a model or opens a socket. Sessions are
 * read-only input, and only `.jsonl` files are read: a file target with another
 * extension is rejected before any read. The only writes go to the output
 * directory. `logs/` is git-ignored, so a real run cannot land in the repo.
 *
 * Entry shapes come from `src/session/jsonl.ts`. The miner reads the entries in
 * append order, not only the active parent chain: a retry truncates the
 * transcript and starts a new branch, so the failed run that caused it is
 * abandoned. That abandoned run is the evidence the eval loop needs.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { redactText } from "../../src/privacy/redaction";
import { displayPath, timestampSlug } from "./trace-utils";

export type TraceSeverity = "high" | "medium" | "low";

export interface TraceUserTurn {
  text: string;
  images: number;
}

export interface TraceToolCall {
  name: string;
  isError?: boolean;
}

export interface TraceCandidate {
  id: string;
  session: string;
  pluginVersion?: string;
  model?: string;
  date?: string;
  signal: string;
  severity: TraceSeverity;
  userTurns: TraceUserTurn[];
  toolCalls: TraceToolCall[];
  evidence: string;
  replayHint: string;
}

export interface TraceMiningResult {
  candidates: TraceCandidate[];
  sessions: number;
  corruptLines: number;
  /** Candidate count before `--max`; the report shows both numbers. */
  minedCount: number;
}

export interface TraceMinerOptions {
  sessions: string;
  out: string;
  max?: number;
  now?: Date;
}

export interface TraceMiningOutput extends TraceMiningResult {
  outDir: string;
  candidatesFile: string;
  reportFile: string;
}

export interface MiningArgs {
  sessions: string;
  out?: string;
  max?: number;
  help: boolean;
}

const MAX_EVIDENCE_CHARS = 280;
const MAX_USER_TURN_CHARS = 400;
const MAX_USER_TURNS = 3;
const MAX_TOOL_CALLS = 20;
const LONG_CHAIN_LIMIT = 15;
const REPEATED_CALL_LIMIT = 3;
const REPORT_TOP_LIMIT = 20;

const SIGNAL_RANK: Record<string, number> = {
  "tool-error": 90,
  "approval-stopped": 88,
  "approval-declined": 86,
  "user-correction": 80,
  retry: 70,
  "long-chain": 60,
  "repeated-tool-call": 50,
  "recovery-signal": 40,
};

const SEVERITY_RANK: Record<TraceSeverity, number> = { high: 3, medium: 2, low: 1 };
const APPROVAL_KINDS = ["approval-stopped", "approval-declined"] as const;

const CORRECTION_PATTERN = /\b(?:no|wrong|not what|undo|try again|fix it)\b/i;
const STOPPED_APPROVAL_PATTERNS: readonly RegExp[] = [
  /The turn was stopped before approval\.?/i,
  /\bOperation aborted\b/i,
  /\bSTOPPED_APPROVAL_REASON\b/,
];
const USER_DECLINED_PATTERN = /\bUser declined\b/i;
const RECOVERY_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: "File not found", pattern: /\bfile not found\b/i },
  { label: "oldText was not found", pattern: /\boldText was not found\b/i },
  { label: "HTTP 429", pattern: /\bHTTP\s*(?:\/\d(?:\.\d)?\s*)?429\b/i },
  { label: "429 Too Many Requests", pattern: /\b429\s+too many requests\b/i },
  { label: "folder exists", pattern: /\bfolder (?:already )?exists\b/i },
  { label: "not empty", pattern: /\bnot empty\b/i },
];

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const GITHUB_PAT_PATTERN = /\bgithub_pat_\w{20,}\b/g;
const GITHUB_TOKEN_PATTERN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;
// Match the whole path, dot segments included. The last character must not be
// sentence punctuation, so "/root/.ssh/id_rsa." keeps its final period.
const ABSOLUTE_PATH_PATTERN = /\/(?:home|Users|root)\b(?:\/[^\s"'`<>()[\]]*[^\s"'`<>()[\].,;:!?])?/g;
// The normal block is `<context>…</context>`; the compressed marker is
// `<context unchanged since previous turn. Attached: …</context>` with no `>`
// after the attribute text. Match both from `<context` to the closing tag.
const CONTEXT_BLOCK_PATTERN = /<context\b[\s\S]*?<\/context>/gi;
const FOCUS_HINT_PATTERN = /^[ \t]*Focus: The user's request after this line is the primary task\.[^\n]*$/gm;
const EDIT_PAYLOAD_PATTERN =
  /(\boldText (?:was not found|must match exactly once|matches \d+ times[^:\n]*)):\s*"(?:\\.|[^"\\])*"/g;
const EDIT_PAYLOAD_OPEN_PATTERN =
  /(\boldText (?:was not found|must match exactly once|matches \d+ times[^:\n]*)):\s*"[^\n]*/g;
const EDIT_FUZZY_LINE_PATTERN = /^[ \t]*(?:Closest match|Next closest) \(line \d+\):.*$/gim;

interface RawEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  pluginVersion?: unknown;
  provider?: unknown;
  modelId?: unknown;
  message?: RawMessage;
  event?: RawEvent;
  [key: string]: unknown;
}

interface RawMessage {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  provider?: unknown;
  model?: unknown;
  [key: string]: unknown;
}

interface RawEvent {
  category?: unknown;
  action?: unknown;
  decision?: unknown;
  reason?: unknown;
  toolName?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  [key: string]: unknown;
}

interface ContentBlock {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  [key: string]: unknown;
}

interface ToolCallRecord {
  id?: string;
  name: string;
  args: unknown;
  isError: boolean;
}

interface ToolErrorRecord {
  toolName: string;
  toolCallId?: string;
  text: string;
  recovery: string[];
}

interface ApprovalRecord {
  toolName: string;
  reason: string;
  kind: "approval-stopped" | "approval-declined";
}

interface RecoveryRecord {
  source: string;
  labels: string[];
}

interface TurnRecord {
  index: number;
  text: string;
  images: number;
  synthetic: boolean;
  assistantSeen: boolean;
  endedWithError: boolean;
  toolCalls: ToolCallRecord[];
  errors: ToolErrorRecord[];
  approvals: ApprovalRecord[];
  recovery: RecoveryRecord[];
}

interface SessionMetadata {
  date?: string;
  model?: string;
  pluginVersion?: string;
}

interface RawCandidate {
  signal: string;
  severity: TraceSeverity;
  userTurns: TraceUserTurn[];
  toolCalls: TraceToolCall[];
  evidence: string;
  replayHint: string;
}

/** Pure: mine one in-memory JSONL session. Never touches disk. */
export function mineSessionText(text: string, session = "(session)"): TraceCandidate[] {
  return mineSession(text, session).candidates;
}

/** Pure: mine one session body and keep the corrupt-line count. */
function mineSession(text: string, session: string): { candidates: TraceCandidate[]; corruptLines: number } {
  const parsed = parseSessionLines(text);
  const header = parsed.entries.find((entry) => entry.type === "session");
  const metadata = sessionMetadata(parsed.entries, header);
  const turns = buildTurns(parsed.entries);
  const raw = buildCandidates(turns);
  raw.sort((left, right) => candidateRank(right) - candidateRank(left));

  const hash = sessionHash(session);
  const candidates = raw.map((candidate, index) => {
    const output: TraceCandidate = {
      id: `trace-${hash}-${index + 1}`,
      session,
      signal: candidate.signal,
      severity: candidate.severity,
      userTurns: candidate.userTurns,
      toolCalls: candidate.toolCalls,
      evidence: candidate.evidence,
      replayHint: candidate.replayHint,
    };
    if (metadata.pluginVersion) output.pluginVersion = metadata.pluginVersion;
    if (metadata.model) output.model = metadata.model;
    if (metadata.date) output.date = metadata.date;
    return output;
  });
  return { candidates, corruptLines: parsed.corruptLines };
}

/** Mine a directory of JSONL files, or one JSONL file. */
export function mineTarget(target: string, max?: number): TraceMiningResult {
  const files = resolveSessionFiles(target);
  if (files.length === 0) throw new Error(`No JSONL session files found at ${target}`);

  const candidates: TraceCandidate[] = [];
  let corruptLines = 0;
  for (const file of files) {
    const mined = mineSession(readFileSync(file, "utf8"), path.basename(file));
    candidates.push(...mined.candidates);
    corruptLines += mined.corruptLines;
  }
  const minedCount = candidates.length;
  candidates.sort(compareCandidates);
  return {
    candidates: typeof max === "number" ? candidates.slice(0, max) : candidates,
    sessions: files.length,
    corruptLines,
    minedCount,
  };
}

export async function writeMiningResult(
  result: TraceMiningResult,
  outDir: string,
  now = new Date(),
): Promise<{ candidatesFile: string; reportFile: string }> {
  await mkdir(outDir, { recursive: true });
  const candidatesFile = path.join(outDir, "candidates.json");
  const reportFile = path.join(outDir, "report.md");
  await writeFile(candidatesFile, `${JSON.stringify(result.candidates, null, 2)}\n`);
  await writeFile(reportFile, renderReport(result, now));
  return { candidatesFile, reportFile };
}

export async function runTraceMiner(options: TraceMinerOptions): Promise<TraceMiningOutput> {
  const result = mineTarget(options.sessions, options.max);
  const files = await writeMiningResult(result, options.out, options.now ?? new Date());
  return { ...result, outDir: options.out, ...files };
}

export function parseMiningArgs(argv: string[]): MiningArgs {
  const parsed: MiningArgs = { sessions: "", help: false };
  let index = 0;
  while (index < argv.length) {
    index = applyMiningArg(argv, index, parsed);
  }
  if (!parsed.sessions && !parsed.help) throw new Error("--sessions is required.");
  return parsed;
}

function applyMiningArg(argv: string[], index: number, parsed: MiningArgs): number {
  const arg = argv[index];
  if (arg === "--sessions") {
    parsed.sessions = requireOptionValue(argv, index, "--sessions", "a directory or JSONL file");
    return index + 2;
  }
  if (arg === "--out") {
    parsed.out = requireOptionValue(argv, index, "--out", "a directory");
    return index + 2;
  }
  if (arg === "--max") {
    parsed.max = parseMaxOption(argv[index + 1]);
    return index + 2;
  }
  if (arg === "--help" || arg === "-h") {
    parsed.help = true;
    return index + 1;
  }
  throw new Error(`Unknown option: ${String(arg)}`);
}

function requireOptionValue(argv: string[], index: number, flag: string, noun: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} needs ${noun}.`);
  return value;
}

function parseMaxOption(value: string | undefined): number {
  const max = Number(value);
  if (!Number.isInteger(max) || max < 1) throw new Error("--max needs a positive integer.");
  return max;
}

function resolveSessionFiles(target: string): string[] {
  const resolved = path.resolve(target);
  if (!existsSync(resolved)) return [];
  const stat = statSync(resolved);
  if (stat.isFile()) {
    if (!resolved.toLowerCase().endsWith(".jsonl")) {
      throw new Error(
        `Refusing to read a non-.jsonl file: ${path.basename(resolved)}. Pass a session .jsonl file or a directory.`,
      );
    }
    return [resolved];
  }
  if (!stat.isDirectory()) return [];
  return readdirSync(resolved)
    .filter((name) => name.endsWith(".jsonl"))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((name) => path.join(resolved, name));
}

function parseSessionLines(text: string): { entries: RawEntry[]; corruptLines: number } {
  const entries: RawEntry[] = [];
  let corruptLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) entries.push(value as RawEntry);
      else corruptLines += 1;
    } catch {
      corruptLines += 1;
    }
  }
  return { entries, corruptLines };
}

function sessionMetadata(entries: RawEntry[], header: RawEntry | undefined): SessionMetadata {
  return {
    date: sessionDate(entries, header),
    model: sessionModel(entries),
    pluginVersion: asString(header?.pluginVersion),
  };
}

function sessionDate(entries: RawEntry[], header: RawEntry | undefined): string | undefined {
  const timestamp = asString(header?.timestamp) ?? firstEntryTimestamp(entries);
  return timestamp ? timestamp.slice(0, 10) : undefined;
}

function firstEntryTimestamp(entries: RawEntry[]): string | undefined {
  for (const entry of entries) {
    const timestamp = asString(entry.timestamp);
    if (timestamp) return timestamp;
  }
  return undefined;
}

function sessionModel(entries: RawEntry[]): string | undefined {
  let model: string | undefined;
  for (const entry of entries) {
    const candidate = modelFromEntry(entry);
    if (candidate) model = candidate;
  }
  return model;
}

function modelFromEntry(entry: RawEntry): string | undefined {
  if (entry.type === "model_change") return pairLabel(entry.provider, entry.modelId);
  if (entry.type === "message" && entry.message?.role === "assistant") return assistantModelLabel(entry.message);
  return undefined;
}

function assistantModelLabel(message: RawMessage): string | undefined {
  const provider = asString(message.provider) ?? "";
  const modelId = asString(message.model) ?? "";
  if (provider && modelId) return `${provider}/${modelId}`;
  return modelId || undefined;
}

function pairLabel(provider: unknown, modelId: unknown): string | undefined {
  if (typeof provider !== "string" || typeof modelId !== "string") return undefined;
  return `${provider}/${modelId}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function buildTurns(entries: RawEntry[]): TurnRecord[] {
  const turns: TurnRecord[] = [];
  let current: TurnRecord | undefined;

  const startTurn = (text: string, images: number, synthetic: boolean): TurnRecord => {
    const turn: TurnRecord = {
      index: turns.length,
      text,
      images,
      synthetic,
      assistantSeen: false,
      endedWithError: false,
      toolCalls: [],
      errors: [],
      approvals: [],
      recovery: [],
    };
    turns.push(turn);
    current = turn;
    return turn;
  };
  const ensureTurn = (): TurnRecord => current ?? startTurn("", 0, true);

  for (const entry of entries) {
    if (entry.type === "message" && entry.message) {
      const message = entry.message;
      if (message.role === "user") {
        startTurn(stripPromptContext(messageText(message)), countImages(message), false);
        continue;
      }
      if (message.role === "assistant") recordAssistant(message, ensureTurn());
      else if (message.role === "toolResult") recordToolResult(message, ensureTurn());
      continue;
    }
    if (entry.type === "action_audit" && entry.event) recordAuditEvent(entry.event, ensureTurn());
  }
  return turns;
}

function recordAssistant(message: RawMessage, turn: TurnRecord): void {
  turn.assistantSeen = true;
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
  if (stopReason === "error" || stopReason === "aborted") turn.endedWithError = true;

  const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : "";
  if (errorMessage.trim()) {
    for (const approval of approvalTextHits(errorMessage, "assistant error")) turn.approvals.push(approval);
    const labels = recoveryLabels(errorMessage);
    if (labels.length > 0) turn.recovery.push({ source: "assistant error", labels });
  }

  for (const block of contentBlocks(message)) {
    if (block.type !== "toolCall") continue;
    addToolCall(turn, {
      id: typeof block.id === "string" ? block.id : undefined,
      name: typeof block.name === "string" ? block.name : "(unknown)",
      args: block.arguments,
      isError: false,
    });
  }
}

function recordToolResult(message: RawMessage, turn: TurnRecord): void {
  const toolName = typeof message.toolName === "string" ? message.toolName : "(unknown)";
  const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
  const text = messageText(message);
  const isError = message.isError === true;
  markToolCallError(turn, toolCallId, toolName, isError);

  for (const approval of approvalTextHits(text, toolName)) turn.approvals.push(approval);

  if (isError) {
    const recovery = recoveryLabels(text);
    const existing = toolCallId ? turn.errors.find((error) => error.toolCallId === toolCallId) : undefined;
    if (existing) {
      existing.text = text;
      existing.recovery = recovery;
    } else {
      turn.errors.push({ toolName, toolCallId, text, recovery });
    }
    return;
  }
  const labels = recoveryLabels(text);
  if (labels.length > 0) turn.recovery.push({ source: toolName, labels });
}

function recordAuditEvent(event: RawEvent, turn: TurnRecord): void {
  if (isToolStartEvent(event)) {
    recordAuditToolStart(event, turn);
    return;
  }
  if (isToolErrorEvent(event)) {
    recordAuditToolError(event, turn);
    return;
  }
  if (isDeniedApprovalEvent(event)) recordAuditApproval(event, turn);
}

function isToolStartEvent(event: RawEvent): boolean {
  return event.category === "tool_call" && event.action === "start";
}

function isToolErrorEvent(event: RawEvent): boolean {
  return event.category === "tool_call" && event.action === "end" && event.isError === true;
}

function isDeniedApprovalEvent(event: RawEvent): boolean {
  return event.category === "approval" && event.action === "decision" && event.decision === "denied";
}

function recordAuditToolStart(event: RawEvent, turn: TurnRecord): void {
  addToolCall(turn, {
    id: asString(event.toolCallId),
    name: asString(event.toolName) ?? "(unknown)",
    args: event.args,
    isError: false,
  });
}

function recordAuditToolError(event: RawEvent, turn: TurnRecord): void {
  const toolName = asString(event.toolName) ?? "(unknown)";
  const toolCallId = asString(event.toolCallId);
  markToolCallError(turn, toolCallId, toolName, true);
  const known = toolCallId ? turn.errors.some((error) => error.toolCallId === toolCallId) : false;
  if (!known) turn.errors.push({ toolName, toolCallId, text: "", recovery: [] });
}

function recordAuditApproval(event: RawEvent, turn: TurnRecord): void {
  const reason = asString(event.reason) ?? "";
  turn.approvals.push({
    toolName: asString(event.toolName) ?? "(unknown)",
    reason,
    kind: isStoppedApproval(reason) ? "approval-stopped" : "approval-declined",
  });
}

function addToolCall(turn: TurnRecord, call: ToolCallRecord): void {
  if (call.id && turn.toolCalls.some((existing) => existing.id === call.id)) return;
  turn.toolCalls.push(call);
}

function markToolCallError(turn: TurnRecord, id: string | undefined, name: string, isError: boolean): void {
  if (!isError) return;
  const existing = id ? turn.toolCalls.find((call) => call.id === id) : undefined;
  if (existing) {
    existing.isError = true;
    return;
  }
  turn.toolCalls.push({ id, name, args: undefined, isError: true });
}

function buildCandidates(turns: TurnRecord[]): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  for (const [index, turn] of turns.entries()) {
    addTurnCandidates(candidates, turn, index > 0 ? turns[index - 1] : undefined);
  }
  candidates.push(...repeatedToolCallCandidates(turns));
  return candidates;
}

function addTurnCandidates(candidates: RawCandidate[], turn: TurnRecord, previous: TurnRecord | undefined): void {
  candidates.push(...toolErrorCandidates(turn));
  candidates.push(...approvalCandidates(turn));
  const correction = correctionCandidate(turn, previous);
  if (correction) candidates.push(correction);
  const retry = retryCandidate(turn, previous);
  if (retry) candidates.push(retry);
  const longChain = longChainCandidate(turn);
  if (longChain) candidates.push(longChain);
  const recovery = recoveryCandidate(turn);
  if (recovery) candidates.push(recovery);
}

function toolErrorCandidates(turn: TurnRecord): RawCandidate[] {
  return turn.errors.map((error): RawCandidate => {
    const detail = error.text.trim() ? redactTraceText(stripEditErrorContent(error.text)) : "no error text";
    const recovery = error.recovery.length > 0 ? ` [recovery: ${error.recovery.join(", ")}]` : "";
    return {
      signal: "tool-error",
      severity: "high",
      userTurns: userTurnsFor([turn]),
      toolCalls: toolCallsFor([turn]),
      evidence: finishEvidence(`Tool ${error.toolName} returned an error: ${detail}${recovery}`),
      replayHint: `Replay the user turn with ${error.toolName} stubbed to return this error; assert the assistant recovers without repeating the call.`,
    };
  });
}

function approvalCandidates(turn: TurnRecord): RawCandidate[] {
  const kinds = new Set(turn.approvals.map((approval) => approval.kind));
  return APPROVAL_KINDS.filter((kind) => kinds.has(kind)).map((kind) => approvalCandidate(turn, kind));
}

function approvalCandidate(turn: TurnRecord, kind: "approval-stopped" | "approval-declined"): RawCandidate {
  const approval = turn.approvals.find((entry) => entry.kind === kind);
  const tool = approval?.toolName ?? "a tool";
  const verdict = kind === "approval-stopped" ? "was stopped" : "was declined";
  const reason = approval?.reason ? `: ${excerptText(approval.reason)}` : "";
  return {
    signal: kind,
    severity: "high",
    userTurns: userTurnsFor([turn]),
    toolCalls: toolCallsFor([turn]),
    evidence: finishEvidence(`Approval for ${tool} ${verdict}${reason}`),
    replayHint:
      kind === "approval-stopped"
        ? `Replay and stop the turn at the ${tool} approval; assert the turn ends cleanly with no further tool calls.`
        : `Replay with the approval answer set to deny ${tool}; assert the assistant asks for a safer alternative instead of retrying.`,
  };
}

function correctionCandidate(turn: TurnRecord, previous: TurnRecord | undefined): RawCandidate | undefined {
  if (!canCompareWithPrevious(turn, previous)) return undefined;
  if (!previous.assistantSeen || !CORRECTION_PATTERN.test(turn.text)) return undefined;
  return {
    signal: "user-correction",
    severity: "medium",
    userTurns: userTurnsFor([previous, turn]),
    toolCalls: toolCallsFor([previous, turn]),
    evidence: finishEvidence(`User corrected the assistant: "${excerptText(turn.text)}"`),
    replayHint:
      "Replay the earlier turn, then send this correction; assert the assistant applies it without repeating the wrong action.",
  };
}

function retryCandidate(turn: TurnRecord, previous: TurnRecord | undefined): RawCandidate | undefined {
  if (!canCompareWithPrevious(turn, previous)) return undefined;
  if (!turn.text.trim()) return undefined;
  if (normalizeUserText(turn.text) !== normalizeUserText(previous.text)) return undefined;
  const why = previous.endedWithError ? "after an error or abort" : "twice in a row";
  return {
    signal: "retry",
    severity: "medium",
    userTurns: userTurnsFor([previous, turn]),
    toolCalls: toolCallsFor([previous]),
    evidence: finishEvidence(`Repeated user text ${why}: "${excerptText(turn.text)}"`),
    replayHint:
      "Replay the repeated user text once; assert one response handles it and no duplicate tool batch runs.",
  };
}

function longChainCandidate(turn: TurnRecord): RawCandidate | undefined {
  if (turn.toolCalls.length <= LONG_CHAIN_LIMIT) return undefined;
  return {
    signal: "long-chain",
    severity: "medium",
    userTurns: userTurnsFor([turn]),
    toolCalls: toolCallsFor([turn]),
    evidence: `${turn.toolCalls.length} tool calls in one user turn (limit ${LONG_CHAIN_LIMIT})`,
    replayHint: `Replay with a ${LONG_CHAIN_LIMIT}-call budget; assert the assistant batches or stops before exceeding it.`,
  };
}

function recoveryCandidate(turn: TurnRecord): RawCandidate | undefined {
  if (turn.recovery.length === 0) return undefined;
  const labels = unique(turn.recovery.flatMap((hit) => hit.labels));
  const sources = unique(turn.recovery.map((hit) => hit.source));
  return {
    signal: "recovery-signal",
    severity: "low",
    userTurns: userTurnsFor([turn]),
    toolCalls: toolCallsFor([turn]),
    evidence: finishEvidence(`Recovery signal in ${sources.join(", ")}: ${labels.join(", ")}`),
    replayHint: `Replay with ${sources[0] ?? "the tool"} returning this recovery text; assert the assistant adapts instead of ending the turn.`,
  };
}

function canCompareWithPrevious(turn: TurnRecord, previous: TurnRecord | undefined): previous is TurnRecord {
  return previous !== undefined && !previous.synthetic && !turn.synthetic;
}

function repeatedToolCallCandidates(turns: TurnRecord[]): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  for (const group of groupToolCalls(turns).values()) {
    if (group.turns.length < REPEATED_CALL_LIMIT) continue;
    const turn = group.turns[REPEATED_CALL_LIMIT - 1];
    if (turn) candidates.push(repeatedToolCallCandidate(group.toolName, group.turns.length, turn));
  }
  return candidates;
}

function groupToolCalls(turns: TurnRecord[]): Map<string, { toolName: string; turns: TurnRecord[] }> {
  const callsByKey = new Map<string, { toolName: string; turns: TurnRecord[] }>();
  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      const key = `${call.name}\u0000${stableStringify(call.args ?? {})}`;
      const group = callsByKey.get(key) ?? { toolName: call.name, turns: [] };
      group.turns.push(turn);
      callsByKey.set(key, group);
    }
  }
  return callsByKey;
}

function repeatedToolCallCandidate(toolName: string, count: number, turn: TurnRecord): RawCandidate {
  return {
    signal: "repeated-tool-call",
    severity: "medium",
    userTurns: userTurnsFor([turn]),
    toolCalls: toolCallsFor([turn]),
    evidence: `${toolName} called ${count} times with identical arguments`,
    replayHint: `Replay with ${toolName} counted; assert the third identical call is blocked or its result is reused.`,
  };
}

function userTurnsFor(turns: TurnRecord[]): TraceUserTurn[] {
  return turns
    .filter((turn) => !turn.synthetic && turn.text.trim())
    .slice(-MAX_USER_TURNS)
    .map((turn) => ({ text: redactTraceText(turn.text, MAX_USER_TURN_CHARS), images: turn.images }));
}

function toolCallsFor(turns: TurnRecord[]): TraceToolCall[] {
  const seen = new Set<string>();
  const calls: TraceToolCall[] = [];
  for (const turn of turns) {
    for (const call of turn.toolCalls) {
      if (calls.length >= MAX_TOOL_CALLS) return calls;
      if (call.id && seen.has(call.id)) continue;
      if (call.id) seen.add(call.id);
      calls.push(toTraceToolCall(call));
    }
  }
  return calls;
}

function toTraceToolCall(call: ToolCallRecord): TraceToolCall {
  return call.isError ? { name: call.name, isError: true } : { name: call.name };
}

function messageText(message: RawMessage): string {
  if (typeof message.content === "string") return message.content;
  return contentBlocks(message)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

function contentBlocks(message: RawMessage): ContentBlock[] {
  return Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
}

function countImages(message: RawMessage): number {
  return contentBlocks(message).filter((block) => block.type === "image").length;
}

/**
 * Remove the `<context>` preamble (attached note bodies and the compressed
 * `Attached:` marker) and the focus hint, so a candidate keeps only the user's
 * own request and never a copied note body or attached path list.
 */
function stripPromptContext(text: string): string {
  const withoutContext = text.replace(CONTEXT_BLOCK_PATTERN, " ").replace(FOCUS_HINT_PATTERN, " ");
  return trimTrailingHorizontalWhitespace(withoutContext).replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * An `oldText` edit error quotes the attempted payload and appends up to two
 * real note lines as fuzzy hints. Keep the non-content prefix; drop the rest.
 */
function stripEditErrorContent(text: string): string {
  const withoutPayload = text
    .replace(EDIT_PAYLOAD_PATTERN, "$1: [oldText]")
    .replace(EDIT_PAYLOAD_OPEN_PATTERN, "$1: [oldText]")
    .replace(EDIT_FUZZY_LINE_PATTERN, "");
  return trimTrailingHorizontalWhitespace(withoutPayload).replace(/\n{3,}/g, "\n\n").trim();
}

function trimTrailingHorizontalWhitespace(text: string): string {
  return text.split("\n").map(trimLineEnd).join("\n");
}

function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end -= 1;
  return line.slice(0, end);
}

function normalizeUserText(text: string): string {
  return stripTrailingSentencePunctuation(text.toLowerCase().replace(/\s+/g, " ").trim());
}

function stripTrailingSentencePunctuation(text: string): string {
  let end = text.length;
  while (end > 0) {
    const char = text[end - 1];
    if (char !== "." && char !== "!" && char !== "?") break;
    end -= 1;
  }
  return text.slice(0, end);
}

function approvalTextHits(text: string, source: string): ApprovalRecord[] {
  if (!text.trim()) return [];
  const hits: ApprovalRecord[] = [];
  const stopped = firstMatch(STOPPED_APPROVAL_PATTERNS, text);
  if (stopped) hits.push({ toolName: source, reason: stopped, kind: "approval-stopped" });
  const declined = USER_DECLINED_PATTERN.exec(text);
  if (declined) hits.push({ toolName: source, reason: declined[0], kind: "approval-declined" });
  return hits;
}

function isStoppedApproval(reason: string): boolean {
  return STOPPED_APPROVAL_PATTERNS.some((pattern) => pattern.test(reason));
}

function firstMatch(patterns: readonly RegExp[], text: string): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return undefined;
}

function recoveryLabels(text: string): string[] {
  return RECOVERY_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
  const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(",")}}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** First local rules (emails, URL query values, paths, GitHub tokens), then the shared text redactor. */
export function redactTraceText(value: string, maxLength = MAX_EVIDENCE_CHARS): string {
  const text = value
    .replace(EMAIL_PATTERN, "[email]")
    .replace(URL_PATTERN, (url) => redactUrlQuery(url))
    .replace(GITHUB_PAT_PATTERN, "[redacted]")
    .replace(GITHUB_TOKEN_PATTERN, "[redacted]")
    .replace(ABSOLUTE_PATH_PATTERN, "/[path]");
  return redactText(text, { maxLength });
}

function redactUrlQuery(url: string): string {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return url;
  const head = url.slice(0, queryIndex + 1);
  const tail = url.slice(queryIndex + 1);
  const hashIndex = tail.indexOf("#");
  const query = hashIndex === -1 ? tail : tail.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : tail.slice(hashIndex);
  const pairs = query.split("&").map((pair) => {
    const equals = pair.indexOf("=");
    if (equals === -1) return pair;
    return `${pair.slice(0, equals)}=[redacted]`;
  });
  return `${head}${pairs.join("&")}${fragment}`;
}

function finishEvidence(text: string): string {
  return redactTraceText(text, MAX_EVIDENCE_CHARS);
}

function excerptText(text: string): string {
  return redactTraceText(text.replace(/\s+/g, " ").trim(), 160);
}

function candidateRank(candidate: { signal: string; severity: TraceSeverity }): number {
  return SEVERITY_RANK[candidate.severity] * 100 + (SIGNAL_RANK[candidate.signal] ?? 0);
}

function compareCandidates(left: TraceCandidate, right: TraceCandidate): number {
  const byRank = candidateRank(right) - candidateRank(left);
  if (byRank !== 0) return byRank;
  const bySession = left.session.localeCompare(right.session);
  if (bySession !== 0) return bySession;
  return candidateIndex(left) - candidateIndex(right);
}

function candidateIndex(candidate: TraceCandidate): number {
  const match = /-(\d+)$/.exec(candidate.id);
  return match ? Number(match[1]) : 0;
}

function sessionHash(session: string): string {
  return createHash("sha256").update(session).digest("hex").slice(0, 8);
}

function renderReport(result: TraceMiningResult, generatedAt: Date): string {
  const lines = [
    "# Trace Mining Report",
    "",
    `- Sessions scanned: ${result.sessions}`,
    `- Candidates: ${result.candidates.length}`,
    `- Mined before --max: ${result.minedCount}`,
    `- Corrupt lines skipped: ${result.corruptLines}`,
    `- Generated: ${generatedAt.toISOString()}`,
    "",
    "## Counts by signal",
    "",
  ];

  const counts = signalCounts(result.candidates);
  if (counts.length === 0) lines.push("No signals found.", "");
  else {
    lines.push(
      markdownTable(
        ["Signal", "Severity", "Count"],
        counts.map((entry) => [entry.signal, entry.severity, entry.count]),
      ),
      "",
    );
  }

  lines.push("## Top candidates", "");
  if (result.candidates.length === 0) lines.push("No candidates.", "");
  else {
    lines.push(
      markdownTable(
        ["ID", "Signal", "Severity", "Session", "Evidence"],
        result.candidates.slice(0, REPORT_TOP_LIMIT).map((candidate) => [
          candidate.id,
          candidate.signal,
          candidate.severity,
          candidate.session,
          candidate.evidence,
        ]),
      ),
      "",
    );
  }

  lines.push(
    "## Redaction",
    "",
    "Emails, `sk-`/`ghp_` style tokens, URL query values, and absolute `/home`, `/Users`, and `/root` paths are replaced. Attached note bodies, compressed `<context>` markers, and the focus hint are removed from user turns. Edit errors lose their quoted `oldText` payload and fuzzy note lines. Tool output is never copied; only tool names and the redacted, truncated error text stay in a candidate.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function signalCounts(
  candidates: TraceCandidate[],
): Array<{ signal: string; severity: TraceSeverity; count: number }> {
  const counts = new Map<string, { signal: string; severity: TraceSeverity; count: number }>();
  for (const candidate of candidates) {
    const entry = counts.get(candidate.signal) ?? {
      signal: candidate.signal,
      severity: candidate.severity,
      count: 0,
    };
    entry.count += 1;
    counts.set(candidate.signal, entry);
  }
  return [...counts.values()].sort(
    (left, right) =>
      right.count - left.count ||
      candidateRank(right) - candidateRank(left) ||
      left.signal.localeCompare(right.signal),
  );
}

function markdownTable(headers: string[], rows: Array<Array<string | number>>): string {
  return [
    `| ${headers.map(markdownCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownCell).join(" | ")} |`),
  ].join("\n");
}

function markdownCell(value: string | number): string {
  return String(value)
    .replaceAll("|", String.raw`\|`)
    .replaceAll("\r\n", " ")
    .replaceAll("\n", " ");
}

function usageText(): string {
  return [
    "Usage:",
    "  npm run trace:mine -- --sessions <dir-or-file> [--out <dir>] [--max <n>]",
    "",
    "Reads session JSONL, writes anonymized candidates.json and report.md.",
    "Default output: logs/trace-mining/<timestamp>/",
  ].join("\n");
}

async function main(): Promise<void> {
  const args = parseMiningArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usageText()}\n`);
    return;
  }
  const now = new Date();
  const out = path.resolve(args.out ?? path.join("logs", "trace-mining", timestampSlug(now)));
  const result = await runTraceMiner({ sessions: args.sessions, out, max: args.max, now });
  const counts = result.candidates.reduce(
    (totals, candidate) => {
      totals[candidate.severity] += 1;
      return totals;
    },
    { high: 0, medium: 0, low: 0 },
  );
  process.stdout.write(
    `[trace:mine] sessions: ${result.sessions}, candidates: ${result.candidates.length} (mined ${result.minedCount})\n`,
  );
  process.stdout.write(`[trace:mine] severity: high ${counts.high}, medium ${counts.medium}, low ${counts.low}\n`);
  process.stdout.write(
    `[trace:mine] output: ${displayPath(result.candidatesFile)}, ${displayPath(result.reportFile)}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`[trace:mine] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
