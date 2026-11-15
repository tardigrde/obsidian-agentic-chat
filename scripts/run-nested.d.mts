export interface NestedArgs {
  screen: string;
  title: string;
  display: number | undefined;
  command: string[];
  help: boolean;
}

export function displaySocket(displayNumber: number): string;
export function parseArgs(argv: string[]): NestedArgs;
export function normalizeDisplay(value: string): number;
export function pickDisplay(isTaken?: (displayNumber: number) => boolean): number;
