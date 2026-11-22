export interface CodeComment {
  file: string;
  line: number;
  endLine: number;
  raw: string;
}

export interface BudgetAddition {
  file: string;
  base: number;
  current: number;
  added: number;
  newComments: CodeComment[];
}

export interface BudgetComparison {
  additions: BudgetAddition[];
  currentTotal: number;
  baseTotal: number;
}

export interface ResolvedBase {
  ref: string;
  sha: string;
}

export const CODE_ROOTS: string[];
export function isFunctionalComment(text: string): boolean;
export function isCodeFile(filePath: string): boolean;
export function scanComments(text: string, filePath?: string): CodeComment[];
export function blankComments(text: string, filePath?: string): string;
export function relativePath(filePath: string, root?: string): string;
export function walkCodeFiles(root?: string): string[];
export function collectComments(root?: string, files?: string[]): Map<string, CodeComment[]>;
export function resolveBase(candidates: Array<string | undefined>, cwd?: string): ResolvedBase | null;
export function changedCodeFiles(sha: string, cwd?: string): Map<string, string>;
export function compareToBase(
  currentByFile: Map<string, CodeComment[]>,
  baseByFile: Map<string, CodeComment[]>,
): BudgetComparison;
export function compareWithBase(candidates: Array<string | undefined>, cwd?: string): (BudgetComparison & { base: ResolvedBase }) | null;
