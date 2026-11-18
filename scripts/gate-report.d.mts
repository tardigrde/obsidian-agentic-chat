export const GATES: Array<{ name: string; workflow: string }>;
export const RED_CONCLUSIONS: Set<string>;
export const FOUND_BY: string[];
export const DEFECTS_FILE: string;
export function countRuns(runs: Array<{ conclusion?: string }>): { total: number; reds: number; byConclusion: Record<string, number> };
export function classifyFailure(log: string): "real" | "flake" | "infra" | "process";
export function foundBy(body: string | undefined): string | undefined;
export function tallyFoundBy(prs: Array<{ body?: string }>): { tally: Record<string, number>; unlabelled: number };
export function formatDigest(input: {
  since: string;
  until: string;
  gates: Array<{ name: string; counts: { total: number; reds: number; byConclusion: Record<string, number> } }>;
  causes?: Record<string, number>;
  foundByTally: { tally: Record<string, number>; unlabelled: number };
  flaky: Array<{ id: string }>;
}): string;
export function defectRows(prs: Array<{ number: number; title: string; body?: string; mergedAt: string }>): string[];
export function renderDefects(doc: string, rows: string[]): string;
export function main(): void;
