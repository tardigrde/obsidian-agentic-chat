const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_HEADER_VALUE_CONTROL = /[\r\n\0]/;

export function isValidHttpHeaderName(value: string): boolean {
  return HTTP_HEADER_NAME.test(value.trim());
}

export function assertValidHttpHeaderName(value: string): string {
  const trimmed = value.trim();
  if (!isValidHttpHeaderName(trimmed)) {
    throw new Error("HTTP header names may contain only RFC token characters.");
  }
  return trimmed;
}

export function assertValidHttpHeaderValue(value: string): string {
  if (HTTP_HEADER_VALUE_CONTROL.test(value)) {
    throw new Error("HTTP header values must not contain line breaks or null bytes.");
  }
  return value;
}
