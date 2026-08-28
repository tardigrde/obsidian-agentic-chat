export type ErrorClass = "transient" | "permanent" | "resource" | "aborted" | "model";

export interface ClassifiedError {
  class: ErrorClass;
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
  message: string;
}

export const INITIAL_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 8000;
export const JITTER_FACTOR = 0.25;

export const MAX_RETRY_AFTER_MS = 60_000;

export function parseRetryAfterMs(value: string | undefined, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^-?\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const diff = dateMs - nowMs;
    if (diff <= 0) return 0;
    return Math.min(diff, MAX_RETRY_AFTER_MS);
  }
  return undefined;
}

export function getRetryAfterMsFromHeaders(
  headers: Record<string, string> | undefined,
  nowMs = Date.now(),
): number | undefined {
  if (!headers) return undefined;
  const raw = headers["retry-after"] ?? headers["Retry-After"] ?? headers["RETRY-AFTER"];
  if (raw === undefined) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === "retry-after") return parseRetryAfterMs(String(value), nowMs);
    }
    return undefined;
  }
  return parseRetryAfterMs(String(raw), nowMs);
}

export function isAbortedError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    const msg = error.message.toLowerCase();
    if (/\babort(ed|ing)?\b/i.test(msg)) return true;
  }
  if (typeof error === "string" && /\babort(ed|ing)?\b/i.test(error)) return true;
  return false;
}

export function isCostCapError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /spend cap|cost cap|costcap/i.test(msg);
}

export function isTimeoutError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /timed out|timeout/i.test(msg) && !isAbortedError(error);
}

function classifyStatus(
  status: number,
  bodyText?: string,
  headers?: Record<string, string>,
  nowMs = Date.now(),
): ClassifiedError {
  const retryAfterMs = getRetryAfterMsFromHeaders(headers, nowMs);
  const message = `HTTP ${status}${bodyText ? `: ${bodyText.slice(0, 500)}` : ""}`;
  if (status === 0) {
    return { class: "transient", retryable: true, status, retryAfterMs, message: bodyText || "network error" };
  }
  if (status === 408 || status === 409 || status === 425 || status === 429) {
    return { class: "transient", retryable: true, status, retryAfterMs, message };
  }
  if (status >= 500 && status <= 599) {
    return { class: "transient", retryable: true, status, retryAfterMs, message };
  }
  if (status === 400 && bodyText && /server connection error|temporar|timeout|upstream|network/i.test(bodyText)) {
    return { class: "transient", retryable: true, status, retryAfterMs, message };
  }
  if (status === 401 || status === 403 || status === 404 || status === 402 || status === 405 || status === 422) {
    return { class: "permanent", retryable: false, status, retryAfterMs, message };
  }
  if (status >= 400 && status < 500) {
    return { class: "permanent", retryable: false, status, retryAfterMs, message };
  }
  return { class: "permanent", retryable: false, status, retryAfterMs, message };
}

export function classifyHttpResponse(
  status: number,
  headers?: Record<string, string>,
  bodyText?: string,
  nowMs = Date.now(),
): ClassifiedError {
  return classifyStatus(status, bodyText, headers, nowMs);
}

export function classifyError(error: unknown, nowMs = Date.now()): ClassifiedError {
  if (isAbortedError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return { class: "aborted", retryable: false, message };
  }
  if (isCostCapError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return { class: "resource", retryable: false, message };
  }
  const rawMessage = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  const lower = rawMessage.toLowerCase();

  if (/content_filter|finish_reason:\s*content_filter/i.test(rawMessage)) {
    return { class: "model", retryable: false, message: rawMessage };
  }

  const statusMatch = /(?:http\s+(\d{3})|status\s+(\d{3}))/i.exec(rawMessage);
  const statusStr = statusMatch?.[1] ?? statusMatch?.[2];
  if (statusStr) {
    const status = Number.parseInt(statusStr, 10);
    if (Number.isFinite(status)) {
      const retryAfterMs = extractRetryAfterFromMessage(rawMessage);
      return classifyStatus(status, rawMessage, retryAfterMs ? { "retry-after": String(retryAfterMs / 1000) } : undefined, nowMs);
    }
  }

  if (/timed out|timeout/i.test(lower) && !/aborted/i.test(lower)) {
    return { class: "transient", retryable: true, message: rawMessage };
  }
  if (/network error|fetch failed|econnreset|etimedout|enotfound|eai_again|upstream|temporar|server connection error/i.test(lower)) {
    return { class: "transient", retryable: true, message: rawMessage };
  }
  if (/unauthorized|forbidden|not found|invalid api key|authentication/i.test(lower)) {
    return { class: "permanent", retryable: false, message: rawMessage };
  }
  return { class: "permanent", retryable: false, message: rawMessage || "unknown error" };
}

function extractRetryAfterFromMessage(_message: string): number | undefined {
  return undefined;
}

export function backoffDelayMs(attempt: number, retryAfterMs?: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const exponential = Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** safeAttempt);
  const jitter = exponential * JITTER_FACTOR * (secureRandom() * 2 - 1);
  let delay = exponential + jitter;
  delay = Math.max(0, Math.min(MAX_BACKOFF_MS, delay));
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs)) {
    const honored = Math.min(MAX_RETRY_AFTER_MS, Math.max(0, retryAfterMs));
    delay = Math.max(delay, honored);
  }
  return Math.round(delay);
}

function secureRandom(): number {
  try {
    const cryptoObj = typeof crypto !== "undefined" ? crypto : undefined;
    if (cryptoObj?.getRandomValues) {
      const array = new Uint32Array(1);
      cryptoObj.getRandomValues(array);
      return array[0] / 0x100000000;
    }
  } catch {
    // fall through
  }
  return Math.random(); // NOSONAR - jitter for backoff, not security-sensitive; crypto is primary
}

export function shouldRetry(classified: ClassifiedError, attempt: number, maxRetries: number): boolean {
  if (!classified.retryable) return false;
  if (classified.class === "aborted" || classified.class === "resource" || classified.class === "model" || classified.class === "permanent") return false;
  return attempt < maxRetries;
}

export async function sleepWithBackoff(
  attempt: number,
  classified: ClassifiedError,
  signal?: AbortSignal,
): Promise<void> {
  const delay = backoffDelayMs(attempt, classified.retryAfterMs);
  if (delay <= 0) return;
  await sleep(delay, signal);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(new Error("Aborted."));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Aborted."));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
