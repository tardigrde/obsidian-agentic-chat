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
}

export interface ReviewGateResult {
  ok: boolean;
  errors: string[];
  verdict: string | null;
  reviewer: string | null;
  commentsAtHead: number;
}

export function isGeneratedFile(file: string): boolean;
export function parseVerdict(
  body: string | null | undefined,
): { verdict: string; head: string; reviewer: string } | null;
export function sizeErrors(input: {
  changedLines: number;
  changedFiles: number;
  labels?: string[];
}): string[];
export function reviewGate(input: ReviewGateInput): ReviewGateResult;
