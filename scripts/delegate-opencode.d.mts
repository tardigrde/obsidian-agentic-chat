export type JobState = "pass" | "failed" | "skipped" | "pending" | "missing" | "unknown";

export interface Check {
  name?: string;
  bucket?: string;
}

export interface FindingComment {
  login?: string;
  commit_id?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
  body?: unknown;
}

export const JOB: string;
export function jobState(checks: Check[] | null): JobState;
export function findingsFor(comments: FindingComment[], head: string): string[];
export function render(state: string, findings: string[], waitedSeconds?: number): string;
export function waitForJob(
  readChecks: () => Check[] | null,
  options: { waitSeconds: number; intervalSeconds: number; sleep?: (seconds: number) => Promise<unknown> },
): Promise<{ state: JobState; waited: number }>;
