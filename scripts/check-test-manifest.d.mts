export interface ManifestGroup {
  id: string;
  tier: "T1" | "T2" | "T3" | "T4";
  runner: "vitest" | "wdio" | "eval";
  globs: string[];
  exclude?: string[];
  triggers: string[];
  needs: { display: boolean; key: boolean; network: boolean };
  budgetSeconds: number;
  command: string;
  why: string;
}
export interface TestManifest {
  version: number;
  testFilePatterns: string[];
  groups: ManifestGroup[];
}
export const MANIFEST_PATH: string;
export function loadManifest(root?: string): TestManifest;
export function groupMatches(group: ManifestGroup, file: string): boolean;
export function groupFor(manifest: TestManifest, file: string): ManifestGroup | undefined;
export function listTestFiles(manifest: TestManifest, root?: string): string[];
export function checkManifest(manifest: TestManifest, files: string[]): { errors: string[]; counts: Map<string, number> };
