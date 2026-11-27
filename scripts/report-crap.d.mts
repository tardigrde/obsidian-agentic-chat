export interface CrapFunction {
  file: string;
  name: string;
  line: number;
  complexity: number;
  coverage: number;
  crap: number;
  level: string;
  [key: string]: unknown;
}

export interface CrapReport {
  summary?: {
    files?: number;
    functions?: number;
    aboveMax?: number;
    [key: string]: unknown;
  };
  functions?: CrapFunction[];
  missingFiles?: string[];
  [key: string]: unknown;
}

export function formatCrapMarkdown(
  report: CrapReport,
  options?: { limit?: number; maxScore?: number },
): string;
export function appendStepSummary(markdown: string, file?: string): boolean;
