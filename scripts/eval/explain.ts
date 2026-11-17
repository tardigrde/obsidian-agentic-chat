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

export interface ExplainedCall {
  name: string;
  args: string;
  isError: boolean;
}

/** Tool calls with arguments from a session JSONL, in order; a result marks its call as an error. */
export function toolCallsFromTrace(raw: string): ExplainedCall[] {
  const calls: ExplainedCall[] = [];
  const byId = new Map<string, ExplainedCall>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: { message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry.message;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
        if (part?.type !== "toolCall" || typeof part.name !== "string") continue;
        const call = { name: part.name, args: JSON.stringify(part.arguments ?? {}), isError: false };
        calls.push(call);
        if (part.id) byId.set(part.id, call);
      }
    } else if (message?.role === "toolResult" && message.isError === true && message.toolCallId) {
      const call = byId.get(message.toolCallId);
      if (call) call.isError = true;
    }
  }
  return calls;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function explainRun(runDir: string, select: { caseId?: string; run?: number } = {}): string {
  const summaryPath = path.join(runDir, "summary.json");
  if (!existsSync(summaryPath)) throw new Error(`no summary.json in ${runDir}`);
  const summary = readJson(summaryPath) as { runId?: string; model?: string; gitHead?: string; cases?: CaseEntry[] };
  const plan = existsSync(path.join(runDir, "plan.json"))
    ? (readJson(path.join(runDir, "plan.json")) as { cases?: Array<{ id: string; prompt?: string }> })
    : {};
  const cases = summary.cases ?? [];

  let picked: { entry: CaseEntry; run: RunEntry } | undefined;
  for (const entry of cases) {
    if (select.caseId && entry.id !== select.caseId) continue;
    for (const run of entry.runResults ?? []) {
      if (select.run !== undefined ? run.run === select.run : run.status === "fail" || run.status === "error") {
        picked = { entry, run };
        break;
      }
    }
    if (picked) break;
  }
  if (!picked) {
    const what = select.caseId ? `${select.caseId}${select.run === undefined ? "" : ` run ${select.run}`}` : "a failed run";
    throw new Error(`${what} not found in ${summaryPath}`);
  }

  const { entry, run } = picked;
  const prompt = plan.cases?.find((evalCase) => evalCase.id === entry.id)?.prompt ?? "(no plan.json)";
  const base = path.join(runDir, "results", entry.id, String(run.run));
  const record = existsSync(`${base}.json`)
    ? (readJson(`${base}.json`) as { observed?: { answer?: string; toolCalls?: Array<{ name: string; isError?: boolean }> } })
    : undefined;
  const calls = existsSync(`${base}.session.jsonl`)
    ? toolCallsFromTrace(readFileSync(`${base}.session.jsonl`, "utf8"))
    : (record?.observed?.toolCalls ?? []).map((call) => ({ name: call.name, args: "(no trace saved)", isError: call.isError === true }));

  const lines = [
    `# ${entry.id} run ${run.run}: ${run.status}`,
    "",
    `Run: ${summary.runId ?? path.basename(runDir)}; model ${summary.model ?? "?"}; head ${summary.gitHead?.slice(0, 7) ?? "?"}; ${run.toolCalls ?? calls.length} tool call(s); $${(run.usd ?? 0).toFixed(5)}; ${((run.ms ?? 0) / 1000).toFixed(1)}s`,
  ];
  if (run.error) lines.push("", `Error: ${run.error}`);
  lines.push("", "## Prompt", "", "```text", prompt, "```", "", "## Tool calls", "");
  if (calls.length === 0) lines.push("(none)");
  calls.forEach((call, index) => lines.push(`${index + 1}. \`${call.name}\`${call.isError ? " (error)" : ""} ${truncate(call.args, 400)}`));
  lines.push("", "## Answer", "", "```text", record?.observed?.answer ?? "(no record)", "```", "", "## Checks", "");
  for (const check of run.checks ?? []) lines.push(`- ${check.ok ? "pass" : "FAIL"} ${check.type}: ${check.detail}`);
  if (!run.checks?.length) lines.push("(none)");
  return `${lines.join("\n")}\n`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
