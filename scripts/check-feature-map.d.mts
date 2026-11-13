export interface FeatureMapResult {
  ok: boolean;
  errors: string[];
  journeys: number;
  rows: number;
  refs: number;
}

export interface EntryPoint {
  kind: string;
  name: string;
  file: string;
  line: number;
}

export function entryPoints(root?: string): EntryPoint[];
export function checkFeatureMap(root?: string): FeatureMapResult;
