export interface ReviewComment {
  author: string;
  body: string;
  updatedAt?: string;
}

export interface ReviewGateInput {
  comments: ReviewComment[];
  author: string;
  headSha: string;
  changedLines: number;
  changedFiles: number;
  labels?: string[];
  singleAccount?: boolean;
  ciGreen?: boolean;
}

export interface ReviewGateResult {
  ok: boolean;
  errors: string[];
  verdict: string | null;
  reviewer: string | null;
  commentsAtHead: number;
  sizeNotes: string[];
}

export function isGeneratedFile(file: string): boolean;
export function parseVerdict(
  body: string | null | undefined,
): { verdict: string; head: string; reviewer: string } | null;
export function sizeNotes(input: { changedLines: number; changedFiles: number; labels?: string[] }): string[];
export function formatReport(
  result: ReviewGateResult,
  size: { changedLines: number; changedFiles: number },
): string[];
export function reviewGate(input: ReviewGateInput): ReviewGateResult;
export function readNumstat(base: string, head: string, cwd?: string): string;
export function measureNumstat(output: string): { changedLines: number; changedFiles: number };
