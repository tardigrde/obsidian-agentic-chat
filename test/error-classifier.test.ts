import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  classifyError,
  classifyHttpResponse,
  getRetryAfterMsFromHeaders,
  parseRetryAfterMs,
  sleep,
} from "../src/agent/error-classifier";

describe("error-classifier", () => {
  it("parses Retry-After seconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("  5  ")).toBe(5000);
  });

  it("parses Retry-After http-date", () => {
    const now = Date.parse("2026-01-01T00:00:00.000Z");
    const future = "Thu, 01 Jan 2026 00:00:02 GMT";
    expect(parseRetryAfterMs(future, now)).toBe(2000);
    const past = "Thu, 01 Jan 2026 00:00:00 GMT";
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });

  it("returns undefined for invalid Retry-After", () => {
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("not-a-date")).toBeUndefined();
  });

  it("extracts Retry-After from headers case-insensitively", () => {
    expect(getRetryAfterMsFromHeaders({ "retry-after": "2" })).toBe(2000);
    expect(getRetryAfterMsFromHeaders({ "Retry-After": "2" })).toBe(2000);
    expect(getRetryAfterMsFromHeaders({ "RETRY-AFTER": "2" })).toBe(2000);
    expect(getRetryAfterMsFromHeaders({})).toBeUndefined();
  });

  it("classifies 429 and 503 as transient retryable", () => {
    expect(classifyHttpResponse(429, {}, "Too Many Requests").retryable).toBe(true);
    expect(classifyHttpResponse(429, {}, "Too Many Requests").class).toBe("transient");
    expect(classifyHttpResponse(503, {}, "Service Unavailable").retryable).toBe(true);
    expect(classifyHttpResponse(500, {}, "Internal Server Error").retryable).toBe(true);
    expect(classifyHttpResponse(408, {}, "").retryable).toBe(true);
  });

  it("classifies 400 with server connection error as transient", () => {
    expect(classifyHttpResponse(400, {}, "Open WebUI: Server Connection Error").retryable).toBe(true);
    expect(classifyHttpResponse(400, {}, "Bad Request").retryable).toBe(false);
  });

  it("classifies 401 and 404 as permanent not retryable", () => {
    expect(classifyHttpResponse(401, {}, "Unauthorized").retryable).toBe(false);
    expect(classifyHttpResponse(401, {}, "Unauthorized").class).toBe("permanent");
    expect(classifyHttpResponse(404, {}, "Not Found").retryable).toBe(false);
  });

  it("classifies status 0 network error as transient", () => {
    expect(classifyHttpResponse(0, {}, "network error").retryable).toBe(true);
    expect(classifyHttpResponse(0, {}, "network error").class).toBe("transient");
  });

  it("classifies cost cap as resource not retryable", () => {
    const err = new Error("Spend cap of $5.00 reached for this conversation.");
    const classified = classifyError(err);
    expect(classified.class).toBe("resource");
    expect(classified.retryable).toBe(false);
  });

  it("classifies aborted as not retryable", () => {
    const err = new Error("Aborted.");
    expect(classifyError(err).class).toBe("aborted");
    expect(classifyError(err).retryable).toBe(false);
    const abortErr = new Error("Request was aborted");
    expect(classifyError(abortErr).class).toBe("aborted");
  });

  it("classifies timeout and network errors as transient", () => {
    expect(classifyError(new Error("Request timed out.")).retryable).toBe(true);
    expect(classifyError(new Error("network error")).retryable).toBe(true);
    expect(classifyError(new Error("MCP request timed out after 30000 ms")).retryable).toBe(true);
  });

  it("classifies 429 from error message as transient", () => {
    const err = new Error("MCP test request failed (HTTP 429).");
    const classified = classifyError(err);
    expect(classified.class).toBe("transient");
    expect(classified.retryable).toBe(true);
    expect(classified.status).toBe(429);
  });

  it("classifies 401 from error message as permanent", () => {
    const err = new Error("OpenAI-compatible request failed (status 401): Unauthorized");
    const classified = classifyError(err);
    expect(classified.class).toBe("permanent");
    expect(classified.retryable).toBe(false);
  });

  it("computes backoff with jitter in range 500→8000 and honors Retry-After", () => {
    const delay0 = backoffDelayMs(0);
    expect(delay0).toBeGreaterThanOrEqual(375);
    expect(delay0).toBeLessThanOrEqual(625);
    const delay1 = backoffDelayMs(1);
    expect(delay1).toBeGreaterThanOrEqual(750);
    expect(delay1).toBeLessThanOrEqual(1250);
    const delayLarge = backoffDelayMs(10);
    expect(delayLarge).toBeGreaterThanOrEqual(6000);
    expect(delayLarge).toBeLessThanOrEqual(8000);
    const withRetryAfter = backoffDelayMs(0, 2000);
    expect(withRetryAfter).toBeGreaterThanOrEqual(2000);
    const withLargeRetryAfter = backoffDelayMs(0, 5000);
    expect(withLargeRetryAfter).toBeGreaterThanOrEqual(5000);
  });

  it("sleep resolves after delay and respects abort", async () => {
    const start = Date.now();
    await sleep(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(5);
    const controller = new AbortController();
    const promise = sleep(100, controller.signal);
    controller.abort();
    await expect(promise).rejects.toThrow(/Aborted/);
  });

  it("honors Retry-After even when larger than exponential cap", () => {
    // Retry-After 10s should be honored even though max backoff is 8s
    const delay = backoffDelayMs(0, 10000);
    expect(delay).toBeGreaterThanOrEqual(10000);
  });
});
