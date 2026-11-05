export function argValue(argv: readonly string[], name: string): string | undefined;

export function parseEnvFile(text: string): Record<string, string>;

export function applyEnvFile(path: string, env?: NodeJS.ProcessEnv): Record<string, string>;

export interface LoadEnvFileOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  fallbackEnvName?: string;
}

export function loadEnvFileFromArgs(options?: LoadEnvFileOptions): string | undefined;

export function envValue(env: NodeJS.ProcessEnv, name: string, fallbackName?: string): string | undefined;

export function hasAnyEnv(env: NodeJS.ProcessEnv, names: readonly string[]): boolean;
