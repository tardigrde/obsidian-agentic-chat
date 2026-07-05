export const REDACTED_VALUE = "[redacted]";

const DEFAULT_MAX_STRING_LENGTH = 500;
const DEFAULT_MAX_ARRAY_LENGTH = 20;
const DEFAULT_MAX_OBJECT_KEYS = 30;
const DEFAULT_MAX_DEPTH = 4;

const SENSITIVE_KEY_PATTERN =
  /(?:api[-_ ]?key|auth(?:orization)?|bearer|client[-_ ]?secret|cookie|password|refresh[-_ ]?token|secret|token)/i;
const CONTENT_KEY_PATTERN = /^(content|before|after|body|text)$/i;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const BASIC_PATTERN = /\bBasic\s+[A-Za-z0-9+/=-]{12,}/gi;
const PROVIDER_KEY_PATTERN = /\b(?:sk|pk|rk|or)-[A-Za-z0-9._-]{8,}\b/g;
const ASSIGNMENT_SECRET_PATTERN =
  /\b(api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|refresh[_ -]?token|secret|password)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^&\s"']+)/gi;
const HIGH_ENTROPY_PATTERN = /\b(?=[A-Za-z0-9+/=]{32,}\b)(?=[A-Za-z0-9+/=]*[A-Za-z])(?=[A-Za-z0-9+/=]*\d)[A-Za-z0-9+/]{32,}={0,2}\b/g;

export interface RedactTextOptions {
  maxLength?: number;
  redactHighEntropy?: boolean;
}

export interface RedactValueOptions extends RedactTextOptions {
  maxArrayLength?: number;
  maxObjectKeys?: number;
  maxDepth?: number;
  summarizeContent?: boolean;
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function containsSensitiveText(value: string): boolean {
  return (
    testPattern(BEARER_PATTERN, value) ||
    testPattern(BASIC_PATTERN, value) ||
    testPattern(PROVIDER_KEY_PATTERN, value) ||
    testPattern(ASSIGNMENT_SECRET_PATTERN, value) ||
    testPattern(HIGH_ENTROPY_PATTERN, value) ||
    /\b(api[_ -]?key|access[_ -]?token|auth[_ -]?token|bearer|client[_ -]?secret|refresh[_ -]?token|secret|password)\b/i.test(value)
  );
}

export function redactText(value: string, options: RedactTextOptions = {}): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_STRING_LENGTH;
  let redacted = value
    .replace(BEARER_PATTERN, `Bearer ${REDACTED_VALUE}`)
    .replace(BASIC_PATTERN, `Basic ${REDACTED_VALUE}`)
    .replace(PROVIDER_KEY_PATTERN, REDACTED_VALUE)
    .replace(ASSIGNMENT_SECRET_PATTERN, `$1=${REDACTED_VALUE}`);
  if (options.redactHighEntropy) redacted = redacted.replace(HIGH_ENTROPY_PATTERN, REDACTED_VALUE);
  return truncateString(redacted, maxLength);
}

export function redactValue(value: unknown, options: RedactValueOptions = {}): unknown {
  return redactValueAtDepth(value, options, 0);
}

export function redactJsonl(value: string, options: RedactValueOptions = {}): string {
  return value
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(redactValue(JSON.parse(line), options));
      } catch {
        return redactText(line, options);
      }
    })
    .join("\n");
}

function redactValueAtDepth(value: unknown, options: RedactValueOptions, depth: number): unknown {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (typeof value === "string") return redactText(value, options);
  if (typeof value !== "object" || value === null) return value;
  if (depth >= maxDepth) return "[truncated]";
  if (Array.isArray(value)) {
    const maxArrayLength = options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH;
    const redacted = value.slice(0, maxArrayLength).map((entry) => redactValueAtDepth(entry, options, depth + 1));
    return value.length > maxArrayLength ? [...redacted, "[truncated]"] : redacted;
  }

  const output: Record<string, unknown> = {};
  const maxObjectKeys = options.maxObjectKeys ?? DEFAULT_MAX_OBJECT_KEYS;
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entry] of entries.slice(0, maxObjectKeys)) {
    output[key] = redactObjectEntry(key, entry, options, depth);
  }
  if (entries.length > maxObjectKeys) output["[truncated]"] = entries.length - maxObjectKeys;
  return output;
}

function redactObjectEntry(key: string, entry: unknown, options: RedactValueOptions, depth: number): unknown {
  if (isSensitiveKey(key)) return REDACTED_VALUE;
  if (options.summarizeContent !== false && CONTENT_KEY_PATTERN.test(key)) return summarizeContent(entry);
  return redactValueAtDepth(entry, options, depth + 1);
}

function summarizeContent(value: unknown): unknown {
  if (typeof value === "string") return `[content ${value.length} chars]`;
  if (Array.isArray(value)) return `[content array ${value.length} items]`;
  if (value && typeof value === "object") return `[content object ${Object.keys(value).length} keys]`;
  return value;
}

function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}
