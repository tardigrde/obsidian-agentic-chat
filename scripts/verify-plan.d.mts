import type { TestManifest } from "./check-test-manifest.mjs";
export interface PlanStep {
  id: string;
  command: string;
  budgetSeconds: number;
  why: string;
  needs: { display?: boolean; key?: boolean; network?: boolean };
  live: boolean;
}
export interface Plan {
  files: string[];
  steps: PlanStep[];
  proposals: string[];
  explain: Array<{ file: string; reasons: string[] }>;
}
export function defaultBase(cwd?: string): string;
export function changedFiles(base: string, cwd?: string): string[];
export function relatedUnitTests(file: string, unitTests: string[]): string[];
export function planFor(files: string[], manifest: TestManifest, testFiles: string[], exists?: (file: string) => boolean): Plan;
