import { readFileSync } from "node:fs";
import process from "node:process";

export function argValue(argv, name) {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  return undefined;
}

export function parseEnvFile(text) {
  const parsed = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    parsed[key] = unquoteEnvValue(rawValue.trim());
  }
  return parsed;
}

export function applyEnvFile(path, env = process.env) {
  const parsed = parseEnvFile(readFileSync(path, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
  return parsed;
}

export function loadEnvFileFromArgs(options = {}) {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const envFile = argValue(argv, "--env-file") || (options.fallbackEnvName ? env[options.fallbackEnvName]?.trim() : "");
  if (!envFile) return undefined;
  applyEnvFile(envFile, env);
  return envFile;
}

export function envValue(env, name, fallbackName) {
  const primary = env[name]?.trim();
  if (primary) return primary;
  if (!fallbackName) return undefined;
  const fallback = env[fallbackName]?.trim();
  return fallback || undefined;
}

export function hasAnyEnv(env, names) {
  return names.some((name) => typeof env[name] === "string" && env[name].trim().length > 0);
}

function unquoteEnvValue(rawValue) {
  if (
    (rawValue.startsWith("\"") && rawValue.endsWith("\"")) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }
  return rawValue.replace(/\s+#.*$/, "").trim();
}
