export const SOURCE_DIR: string;
export const ALLOWLIST: string[][];
export function cycleText(cycle: string[]): string;
export function unexpectedCycles(cycles: string[][], allowlist?: string[][]): string[][];
export function staleAllowlist(cycles: string[][], allowlist?: string[][]): string[][];
export function findCycles(root?: string): Promise<string[][]>;
