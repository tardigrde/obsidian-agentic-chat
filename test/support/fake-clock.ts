import { vi } from "vitest";

/**
 * Run `work` under fake timers and drain every timer it schedules, so a retry
 * backoff or a request timeout costs no wall time. Date is faked too, so a
 * test can still assert how long the code chose to wait.
 */
export async function withFakeClock<T>(work: () => Promise<T>): Promise<{ value: T; waitedMs: number }> {
  vi.useFakeTimers();
  try {
    const start = Date.now();
    const pending = work();
    // Settle the rejection handler now; the caller still sees the rejection.
    pending.catch(() => undefined);
    await vi.runAllTimersAsync();
    const value = await pending;
    return { value, waitedMs: Date.now() - start };
  } finally {
    vi.useRealTimers();
  }
}

/** Like withFakeClock, for work that must reject; returns the error. */
export async function rejectsWithFakeClock(work: () => Promise<unknown>): Promise<Error> {
  try {
    await withFakeClock(work);
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the work to reject, but it resolved");
}
