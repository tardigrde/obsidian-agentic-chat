/**
 * `npm run eval:explain -- <run dir> [--case id] [--run n]` (#393 T21): one
 * failing run on one page. The prompt, every tool call with its arguments (from
 * the session trace the spec saves next to the record), the final answer, and
 * the check evidence. With no --case it picks the first failed or errored run.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

interface RunEntry {
  run: number;
  status: string;
  error?: string;
  toolCalls?: number;
  usd?: number;
  ms?: number;
  checks?: Array<{ type: string; ok: boolean; detail: string }>;
}

interface CaseEntry {
  id: string;
  runResults?: RunEntry[];
}

interface RunSummary {
  runId?: string;
  model?: string;
  gitHead?: string;
  cases?: CaseEntry[];
}

interface RunRecordFile {
  observed?: { answer?: string; toolCalls?: Array<{ name: string; isError?: boolean }> };
}

export interface ExplainedCall {
  name: string;
  args: string;
  isError: boolean;
}

interface TraceMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  isError?: boolean;
}

interface ToolCallPart {
  type?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

function traceMessage(line: string): TraceMessage | undefined {
  if (!line.trim()) return undefined;
  try {
    return (JSON.parse(line) as { message?: TraceMessage }).message;
  } catch {
    return undefined;
  }
}

/** Tool calls with arguments from a session JSONL, in order; a result marks its call as an error. */
export function toolCallsFromTrace(raw: string): ExplainedCall[] {
  const calls: ExplainedCall[] = [];
  const byId = new Map<string, ExplainedCall>();
  for (const message of raw.split("\n").map((line) => traceMessage(line))) {
    if (message?.role === "assistant") addCalls(message, calls, byId);
    else if (message?.role === "toolResult" && message.isError === true && message.toolCallId) {
      const call = byId.get(message.toolCallId);
      if (call) call.isError = true;
    }
  }
  return calls;
}

function addCalls(message: TraceMessage, calls: ExplainedCall[], byId: Map<string, ExplainedCall>): void {
  if (!Array.isArray(message.content)) return;
  const parts = (message.content as ToolCallPart[]).filter((part) => part?.type === "toolCall" && typeof part.name === "string");
  for (const part of parts) {
    const call = { name: part.name as string, args: JSON.stringify(part.arguments ?? {}), isError: false };
    calls.push(call);
    if (part.id) byId.set(part.id, call);
  }
}

/** Read a JSON file under the run directory the developer named; undefined when absent. */
function readJsonIfExists<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as T; // NOSONAR:S8707 -- local dev CLI: the path is the developer's own run directory on their own machine.
}

function wanted(run: RunEntry, select: { run?: number }): boolean {
  if (select.run !== undefined) return run.run === select.run;
  return run.status === "fail" || run.status === "error";
}

function pickRun(cases: CaseEntry[], select: { caseId?: string; run?: number }): { entry: CaseEntry; run: RunEntry } | undefined {
  for (const entry of cases) {
    if (select.caseId && entry.id !== select.caseId) continue;
    const run = (entry.runResults ?? []).find((candidate) => wanted(candidate, select));
    if (run) return { entry, run };
  }
  return undefined;
}

function notFound(select: { caseId?: string; run?: number }): string {
  if (!select.caseId) return "a failed run";
  return select.run === undefined ? select.caseId : `${select.caseId} run ${select.run}`;
}

function readCalls(base: string, record: RunRecordFile | undefined): ExplainedCall[] {
  const tracePath = `${base}.session.jsonl`;
  if (existsSync(tracePath)) {
    return toolCallsFromTrace(readFileSync(tracePath, "utf8")); // NOSONAR:S8707 -- local dev CLI: a file inside the developer's own run directory.
  }
  return (record?.observed?.toolCalls ?? []).map((call) => ({ name: call.name, args: "(no trace saved)", isError: call.isError === true }));
}

function callLine(call: ExplainedCall, index: number): string {
  const marker = call.isError ? " (error)" : "";
  return `${index + 1}. \`${call.name}\`${marker} ${truncate(call.args, 400)}`;
}

export function explainRun(runDir: string, select: { caseId?: string; run?: number } = {}): string {
  const summaryPath = path.join(runDir, "summary.json");
  const summary = readJsonIfExists<RunSummary>(summaryPath);
  if (!summary) throw new Error(`no summary.json in ${runDir}`);
  const plan = readJsonIfExists<{ cases?: Array<{ id: string; prompt?: string }> }>(path.join(runDir, "plan.json"));
  const picked = pickRun(summary.cases ?? [], select);
  if (!picked) throw new Error(`${notFound(select)} not found in ${summaryPath}`);

  const { entry, run } = picked;
  const prompt = plan?.cases?.find((evalCase) => evalCase.id === entry.id)?.prompt ?? "(no plan.json)";
  const base = path.join(runDir, "results", entry.id, String(run.run));
  const record = readJsonIfExists<RunRecordFile>(`${base}.json`);
  const calls = readCalls(base, record);

  const head = summary.gitHead?.slice(0, 7) ?? "?";
  const cost = (run.usd ?? 0).toFixed(5);
  const seconds = ((run.ms ?? 0) / 1000).toFixed(1);
  const lines = [
    `# ${entry.id} run ${run.run}: ${run.status}`,
    "",
    `Run: ${summary.runId ?? path.basename(runDir)}; model ${summary.model ?? "?"}; head ${head}; ${run.toolCalls ?? calls.length} tool call(s); $${cost}; ${seconds}s`,
  ];
  if (run.error) lines.push("", `Error: ${run.error}`);
  lines.push("", "## Prompt", "", "```text", prompt, "```", "", "## Tool calls", "");
  const callLines = calls.length === 0 ? ["(none)"] : calls.map((call, index) => callLine(call, index));
  lines.push(...callLines, "", "## Answer", "", "```text", record?.observed?.answer ?? "(no record)", "```", "", "## Checks", "");
  const checks = run.checks ?? [];
  lines.push(...checks.map((check) => `- ${check.ok ? "pass" : "FAIL"} ${check.type}: ${check.detail}`));
  if (checks.length === 0) lines.push("(none)");
  return `${lines.join("\n")}\n`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
