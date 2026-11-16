export function globToRegExp(glob: string): RegExp;
export function matchesAny(file: string, globs: string[]): boolean;
export function listFiles(root: string, dir: string, skip?: Set<string>): string[];
