export const RUN_RESULT_SCHEMA: string;
export const HISTORY_FILE: string;
export interface Counts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
}
export interface TestRow {
  id: string;
  file: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
}
export interface RunStep {
  label: string;
  tier?: string;
  mode?: string;
  status: string;
  durationMs: number;
  counts?: Counts | null;
  [key: string]: unknown;
}
export interface GitFields {
  head: string | null;
  branch: string | null;
  dirty: boolean;
  worktree: string;
}
export interface RunResult {
  schema: string;
  lane: string;
  args: string[];
  command?: string;
  mode: "live" | "scripted" | "static";
  verdict: string;
  git?: GitFields;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  counts: Counts;
  tiers: Record<string, Counts & { steps: number }>;
  steps: RunStep[];
  tests: TestRow[];
  scope: "all" | string[];
  cost?: { usd: number; tokens?: number };
  artifacts: string[];
}
export type HistoryLine = Record<string, unknown> & {
  lane: string;
  verdict: string;
  head: string | null;
  startedAt: string;
};
export function mainWorktreeRoot(cwd?: string): string;
export function gitInfo(cwd?: string): GitFields;
export function parseVitestJson(json: unknown, root: string): TestRow[];
export function buildRunResult(input: {
  lane: string;
  args?: string[];
  command?: string;
  verdict: string;
  startedAt: number;
  finishedAt: number;
  steps: RunStep[];
  tests?: TestRow[];
  scope?: "all" | string[];
  cost?: { usd: number; tokens?: number };
  artifacts?: string[];
  git?: GitFields;
}): RunResult;
export function historyLine(envelope: RunResult): HistoryLine;
export function historyPath(cwd?: string): string;
export function appendHistory(envelope: RunResult, file?: string): string;
export function readHistory(file: string): HistoryLine[];
export interface HistorySummary {
  runs: number;
  lanes: Array<{ lane: string; runs: number; passRate: number; last: HistoryLine; lastRed?: HistoryLine }>;
  flaky: Array<{ id: string; file: string; heads: string[]; failures: number }>;
  slowerSteps: Array<{ lane: string; label: string; beforeMs: number; recentMs: number }>;
  slowerTests: Array<{ id: string; beforeMs: number; latestMs: number }>;
  cost: Array<{ lane: string; startedAt: string; usd: number }>;
}
export function summarizeHistory(entries: HistoryLine[], options?: { window?: number }): HistorySummary;
