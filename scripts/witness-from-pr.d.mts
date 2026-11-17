export interface WitnessSpec {
  kind: "test" | "removal";
  testFile: string | null;
  sources: string[];
  gone: string[];
  absent: string[];
  errors: string[];
}

export type WitnessDecision =
  | { action: "run"; spec: WitnessSpec }
  | { action: "removal"; spec: WitnessSpec }
  | { action: "skip"; reason: string }
  | { action: "fail"; reason: string; spec?: WitnessSpec };

export interface RemovalResult {
  verdict: "PASS" | "FAIL";
  results: Array<{ check: string; ok: boolean; detail: string }>;
}

export function extractWitnessBlocks(body: string | null | undefined): string[];
export function extractWitnessBlock(body: string | null | undefined): string | null;
export function parseWitnessBlock(block: string | null | undefined): WitnessSpec;
export function validateWitnessSpec(spec: WitnessSpec, root?: string, changedFiles?: string[]): string[];
export function witnessDecision(input: {
  body?: string | null;
  labels?: string[];
  root?: string;
  changedFiles?: string[];
}): WitnessDecision;
export function checkRemoval(input: { base: string; spec: WitnessSpec; cwd?: string }): RemovalResult;
