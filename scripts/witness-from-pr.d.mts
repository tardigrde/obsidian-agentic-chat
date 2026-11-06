export interface WitnessSpec {
  testFile: string | null;
  sources: string[];
  errors: string[];
}

export type WitnessDecision =
  | { action: "run"; spec: WitnessSpec }
  | { action: "skip"; reason: string }
  | { action: "fail"; reason: string; spec?: WitnessSpec };

export function extractWitnessBlocks(body: string | null | undefined): string[];
export function extractWitnessBlock(body: string | null | undefined): string | null;
export function parseWitnessBlock(block: string | null | undefined): WitnessSpec;
export function validateWitnessSpec(spec: WitnessSpec, root?: string): string[];
export function witnessDecision(input: {
  body?: string | null;
  labels?: string[];
  root?: string;
  changedFiles?: string[];
}): WitnessDecision;
