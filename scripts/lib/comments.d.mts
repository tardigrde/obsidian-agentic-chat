export interface CodeComment {
  file: string;
  line: number;
  endLine: number;
  raw: string;
}

export interface Baseline {
  version: number;
  note?: string;
  total: number;
  files: Record<string, number>;
}

export interface BudgetAddition {
  file: string;
  baseline: number;
  current: number;
  newComments: CodeComment[];
}

export interface BudgetComparison {
  additions: BudgetAddition[];
  currentTotal: number;
  baselineTotal: number;
}

export const CODE_ROOTS: string[];
export const BASELINE_PATH: string;
export function isFunctionalComment(text: string): boolean;
export function isCodeFile(filePath: string): boolean;
export function scanComments(text: string, filePath?: string): CodeComment[];
export function relativePath(filePath: string, root?: string): string;
export function walkCodeFiles(root?: string): string[];
export function collectComments(root?: string, files?: string[]): Map<string, CodeComment[]>;
export function readBaseline(baselinePath?: string): Baseline;
export function compareBudget(commentsByFile: Map<string, CodeComment[]>, baseline: Baseline): BudgetComparison;
export function baselineFrom(commentsByFile: Map<string, CodeComment[]>): Baseline;
