export interface DiffCoverageRow {
  file: string;
  executable: number | null;
  covered: number;
  uncovered: number[];
  loaded: boolean;
}
export function parseUnifiedDiff(text: string): Map<string, Set<number>>;
export function diffCoverage(
  changed: Map<string, Set<number>>,
  coverage: Record<string, { path?: string; statementMap?: Record<string, { start: { line: number }; end: { line: number } }>; s?: Record<string, number> }>,
  root?: string,
): DiffCoverageRow[];
export function formatDiffCoverage(rows: DiffCoverageRow[], options?: { markdown?: boolean }): string;
