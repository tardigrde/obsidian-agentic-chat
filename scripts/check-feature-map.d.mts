export interface FeatureMapResult {
  ok: boolean;
  errors: string[];
  journeys: number;
  rows: number;
  refs: number;
}

export function checkFeatureMap(root?: string): FeatureMapResult;
