export const DOC_GLOBS: string[];
export const IGNORED_DOCS: string[];
export function findCommands(text: string): Array<{ line: number; script: string; lane?: string }>;
export function checkDoc(file: string, text: string, scripts: Record<string, string>): string[];
export function listDocs(root?: string): string[];
export const RETIRED_ARGS: Array<{ pattern: RegExp; hint: string }>;
