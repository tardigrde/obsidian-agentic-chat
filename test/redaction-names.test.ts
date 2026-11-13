import { describe, expect, it } from "vitest";
import { containsSensitiveText, isSensitiveKey, redactText } from "../src/privacy/redaction";

/**
 * Every spelling that the secret-key table must know. Keep this list aligned
 * with SECRET_KEY_NAMES: the key redactor, the text redactor, and the memory
 * gate must all agree on each one.
 */
const SECRET_NAMES = [
  "api_key",
  "api-key",
  "api key",
  "access_token",
  "access-token",
  "auth_token",
  "authorization",
  "bearer",
  "client_secret",
  "client-secret",
  "cookie",
  "password",
  "refresh_token",
  "refresh-token",
  "secret",
  "token",
] as const;

describe("secret key names", () => {
  it.each(SECRET_NAMES)("treats %s as a secret in keys, text, and the memory gate", (name) => {
    const value = "abc123secret";
    expect(isSensitiveKey(name)).toBe(true);
    const redacted = redactText(`${name}=${value}`);
    expect(redacted).toContain("[redacted]");
    expect(redacted).not.toContain(value);
    expect(containsSensitiveText(`${name}: ${value}`)).toBe(true);
  });
});

describe("memory gate prose", () => {
  it.each([
    "The token budget is about 4k per turn.",
    "The auth flow uses OAuth in the browser.",
    "I always dismiss the cookie banner.",
    "Authorization is handled by the gateway.",
  ])("keeps generic words in prose: %s", (text) => {
    expect(containsSensitiveText(text)).toBe(false);
  });
});
