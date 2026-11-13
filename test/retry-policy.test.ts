import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  classifyError,
  getRetryAfterMsFromHeaders,
} from "../src/agent/error-classifier";
import { shouldRetryStreamError } from "../src/agent/stream-runtime";
import {
  errorRetryDecision,
  responseRetryDecision,
  type OpenAICompatibleResponse,
} from "../src/llm/openai-compatible-request";

interface StatusRow {
  name: string;
  status: number;
  body: string;
  headers?: Record<string, string>;
  retry: boolean;
}

const statusRows: StatusRow[] = [
  { name: "408", status: 408, body: "Request Timeout", retry: true },
  { name: "409", status: 409, body: "Conflict", retry: true },
  { name: "425", status: 425, body: "Too Early", retry: true },
  { name: "429", status: 429, body: "Too Many Requests", retry: true },
  {
    name: "429 with Retry-After",
    status: 429,
    body: "Too Many Requests",
    headers: { "retry-after": "2" },
    retry: true,
  },
  { name: "500", status: 500, body: "Internal Server Error", retry: true },
  { name: "502", status: 502, body: "Bad Gateway", retry: true },
  { name: "503", status: 503, body: "Service Unavailable", retry: true },
  { name: "400", status: 400, body: "Bad Request", retry: false },
  { name: "401", status: 401, body: "Unauthorized", retry: false },
];

function responseFor(row: StatusRow): OpenAICompatibleResponse {
  return {
    status: row.status,
    headers: row.headers,
    text: row.body,
    json: { error: { message: row.body } },
  };
}

function streamRetry(error: unknown): boolean {
  return shouldRetryStreamError(classifyError(error), false, 0, 1);
}

describe("retry policy table", () => {
  it.each(statusRows)("$name: both engines agree", (row) => {
    const request = responseRetryDecision(responseFor(row), 0, 1);
    const stream = streamRetry(new Error(`HTTP ${row.status}: ${row.body}`));
    // eslint-disable-next-line no-console
    console.log(row.name, "stream", stream, "request", Boolean(request));
    expect(stream).toBe(row.retry);
    expect(Boolean(request)).toBe(row.retry);
  });

  it("429 with Retry-After: both retry and the request engine honors the header", () => {
    const headers = { "retry-after": "2" };
    const decision = responseRetryDecision(
      { status: 429, headers, text: "Too Many Requests", json: { error: { message: "Too Many Requests" } } },
      0,
      1,
    );
    const retryAfterMs = getRetryAfterMsFromHeaders(headers);
    // eslint-disable-next-line no-console
    console.log("429 retry-after", "retryAfterMs", retryAfterMs, "delay", backoffDelayMs(0, retryAfterMs));
    expect(decision).toBeDefined();
    expect(retryAfterMs).toBe(2000);
    expect(backoffDelayMs(0, decision?.classified.retryAfterMs)).toBeGreaterThanOrEqual(2000);
    expect(streamRetry(new Error("HTTP 429: Too Many Requests"))).toBe(true);
  });

  it("network errors: both engines retry", () => {
    const error = new Error("fetch failed");
    const request = errorRetryDecision(error, 0, 1);
    const stream = streamRetry(error);
    // eslint-disable-next-line no-console
    console.log("network", "stream", stream, "request", Boolean(request));
    expect(stream).toBe(true);
    expect(request).toBeDefined();
  });

  it("OpenAI SDK 429 message: both engines retry", () => {
    const error = new Error("429 status code (no body)");
    const request = responseRetryDecision(
      { status: 429, text: "429 status code (no body)", json: { error: { message: "429 status code (no body)" } } },
      0,
      1,
    );
    const stream = streamRetry(error);
    // eslint-disable-next-line no-console
    console.log("sdk 429", "stream", stream, "request", Boolean(request));
    expect(stream).toBe(true);
    expect(request).toBeDefined();
  });
});
