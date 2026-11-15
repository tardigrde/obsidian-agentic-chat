export interface Redactor {
  secrets: string[];
  redact(text: string): string;
}

export interface LineRedactor {
  push(chunk: string): string;
  flush(): string;
}

export interface EnvEntry {
  name: string;
  value: string;
}

export function findRepoRoot(startDir?: string): string;
export function parseEnvFile(text: string): EnvEntry[];
export function collectSecrets(env?: NodeJS.ProcessEnv, envText?: string): string[];
export function redactText(text: string, secrets?: string[]): string;
export function countSecrets(text: string, secrets?: string[]): number;
export function createLineRedactor(redact: (text: string) => string): LineRedactor;
export function createRedactor(options?: { env?: NodeJS.ProcessEnv; root?: string }): Redactor;
