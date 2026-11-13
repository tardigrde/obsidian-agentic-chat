export interface FeatureMapResult {
  ok: boolean;
  errors: string[];
  journeys: number;
  rows: number;
  refs: number;
}

export interface LockWriteResult {
  count: number;
  skipped: number;
}

export interface EntryPoint {
  kind: string;
  name: string;
  file: string;
  line: number;
}

export interface FixMove {
  from: string;
  to: string;
}

export interface FixUnplaced {
  ref: string;
  reason: string;
}

export interface FixResult {
  moved: FixMove[];
  unplaced: FixUnplaced[];
  wroteLock: boolean;
}

export function readLock(root?: string): Record<string, string> | null;
export function writeLock(root?: string): LockWriteResult;
export function entryPoints(root?: string): EntryPoint[];
export function checkFeatureMap(root?: string): FeatureMapResult;
export function fixFeatureMap(root?: string): FixResult;
