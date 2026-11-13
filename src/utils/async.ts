/**
 * Race `promise` against a timer. The timer is always cleared, so a request
 * that settles first leaves no pending timeout behind.
 */
export async function withTimeout<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  timeoutError: () => Error = () => new Error("Timeout"),
): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(timeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}
