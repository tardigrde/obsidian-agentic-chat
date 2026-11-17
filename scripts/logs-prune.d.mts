export interface PruneRule {
  dir: string;
  keepNewest?: number;
  maxAgeDays?: number;
  removeAll?: boolean;
}
export const DEFAULT_RULES: PruneRule[];
export function planPrune(
  root: string,
  options?: { now?: number; rules?: PruneRule[] },
): Array<{ path: string; reason: string; size: number }>;
