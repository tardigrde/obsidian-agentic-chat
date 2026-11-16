import type { TestManifest } from "./check-test-manifest.mjs";
export interface FoundSkip {
  line: number;
  kind: string;
  issue: number | null;
}
export function findSkips(text: string): FoundSkip[];
export function checkSkips(input: {
  manifest: TestManifest;
  files: string[];
  read: (file: string) => string;
}): { errors: string[]; flaky: Array<{ file: string; line: number; issue: number }> };
