/**
 * Mine session JSONL into anonymized failure candidates for the eval loop.
 *
 * Local only: this module never calls a model, opens a socket, or reads a
 * secret. Sessions are read-only input; the only writes go to the output
 * directory.
 *
 * Skeleton: the witness in `test/trace-miner.test.ts` runs against these
 * signatures and fails on its assertions until the miner is implemented.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

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

export function mineSessionText(_text: string, _session = "(session)"): TraceCandidate[] {
  return [];
}

export function mineTarget(_target: string, _max?: number): TraceMiningResult {
  return { candidates: [], sessions: 0, corruptLines: 0, minedCount: 0 };
}

export async function writeMiningResult(
  result: TraceMiningResult,
  outDir: string,
): Promise<{ candidatesFile: string; reportFile: string }> {
  await mkdir(outDir, { recursive: true });
  const candidatesFile = path.join(outDir, "candidates.json");
  const reportFile = path.join(outDir, "report.md");
  await writeFile(candidatesFile, `${JSON.stringify(result.candidates, null, 2)}\n`);
  await writeFile(reportFile, "# Trace Mining Report\n\n- Candidates: 0\n");
  return { candidatesFile, reportFile };
}

export async function runTraceMiner(options: TraceMinerOptions): Promise<TraceMiningOutput> {
  const result = mineTarget(options.sessions, options.max);
  const files = await writeMiningResult(result, options.out);
  return { ...result, outDir: options.out, ...files };
}

export function parseMiningArgs(argv: string[]): MiningArgs {
  const parsed: MiningArgs = { sessions: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--sessions") {
      const value = argv[index + 1];
      if (!value) throw new Error("--sessions needs a directory or JSONL file.");
      parsed.sessions = value;
      index += 1;
      continue;
    }
    if (arg === "--out") {
      const value = argv[index + 1];
      if (!value) throw new Error("--out needs a directory.");
      parsed.out = value;
      index += 1;
      continue;
    }
    if (arg === "--max") {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error("--max needs a positive integer.");
      parsed.max = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    throw new Error(`Unknown option: ${String(arg)}`);
  }
  if (!parsed.sessions && !parsed.help) throw new Error("--sessions is required.");
  return parsed;
}

async function main(): Promise<void> {
  const args = parseMiningArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("Usage: npm run trace:mine -- --sessions <dir-or-file> [--out <dir>] [--max <n>]\n");
    return;
  }
  const now = new Date();
  const out = path.resolve(args.out ?? path.join("logs", "trace-mining", now.toISOString().replace(/[:.]/g, "-")));
  await runTraceMiner({ sessions: args.sessions, out, max: args.max, now });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`[trace:mine] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
