import { describe, expect, it } from "vitest";
import { classifyError } from "../src/agent/error-classifier";

// The OpenAI SDK reports a body-less 429 as "429 status code (no body)". Both
// retry engines read classifyError, so this text must classify as retryable.
describe("classifyError: OpenAI SDK status text", () => {
  it("treats '429 status code (no body)' as a retryable rate limit", () => {
    expect(classifyError(new Error("429 status code (no body)")).retryable).toBe(true);
  });

  it("reads a numeric status on the error object", () => {
    expect(classifyError(Object.assign(new Error("Too Many Requests"), { status: 429 })).retryable).toBe(true);
    expect(classifyError(Object.assign(new Error("Unauthorized"), { status: 401 })).retryable).toBe(false);
  });
});
