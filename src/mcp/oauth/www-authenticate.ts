export function parseWwwAuthenticate(header: string): Record<string, string> {
  const withoutScheme = header.trim().replace(/^Bearer\s+/i, "");
  const params: Record<string, string> = {};
  let index = 0;
  while (index < withoutScheme.length) {
    const param = parseAuthParam(withoutScheme, index);
    if (!param) break;
    params[param.key] = param.value;
    index = param.nextIndex;
  }
  return params;
}

interface ParsedAuthParam {
  key: string;
  value: string;
  nextIndex: number;
}

function parseAuthParam(input: string, startIndex: number): ParsedAuthParam | null {
  let index = skipAuthChars(input, startIndex, /[\s,]/);
  const keyStart = index;
  index = skipAuthChars(input, index, /[A-Za-z0-9_.-]/);
  const key = input.slice(keyStart, index);
  index = skipAuthChars(input, index, /\s/);
  if (!key || input[index] !== "=") return null;
  index = skipAuthChars(input, index + 1, /\s/);
  const parsedValue = parseAuthValue(input, index);
  return { key, value: parsedValue.value, nextIndex: parsedValue.nextIndex };
}

function skipAuthChars(input: string, startIndex: number, pattern: RegExp): number {
  let index = startIndex;
  while (index < input.length && pattern.test(input[index])) index += 1;
  return index;
}

function parseAuthValue(input: string, startIndex: number): { value: string; nextIndex: number } {
  if (input[startIndex] === '"') return parseQuotedAuthValue(input, startIndex + 1);
  return parseUnquotedAuthValue(input, startIndex);
}

function parseQuotedAuthValue(input: string, startIndex: number): { value: string; nextIndex: number } {
  let value = "";
  let index = startIndex;
  while (index < input.length) {
    const char = input[index];
    if (char === "\\") {
      value += input[index + 1] ?? "";
      index += 2;
      continue;
    }
    if (char === '"') {
      index += 1;
      break;
    }
    value += char;
    index += 1;
  }
  return { value, nextIndex: index };
}

function parseUnquotedAuthValue(input: string, startIndex: number): { value: string; nextIndex: number } {
  let index = startIndex;
  while (index < input.length && input[index] !== ",") index += 1;
  return { value: input.slice(startIndex, index).trim(), nextIndex: index };
}
