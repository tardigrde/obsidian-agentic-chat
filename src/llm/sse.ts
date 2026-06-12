/** Thrown when a stream stops producing data for longer than the idle timeout. */
export class StreamIdleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamIdleError";
  }
}

export interface SseOptions {
  /** Abort the stream if no chunk arrives within this many ms. */
  idleTimeoutMs?: number;
  /** Caller cancellation; aborts the in-flight read promptly. */
  signal?: AbortSignal;
}

/**
 * Incremental Server-Sent Events parser.
 *
 * Yields the payload of every `data:` line, handling chunk boundaries that
 * split lines, CRLF endings, and comment lines (`: keep-alive`) that
 * OpenRouter sends while a request is queued.
 *
 * With `idleTimeoutMs`, a stalled connection (headers received but the body
 * stops flowing) raises `StreamIdleError` instead of hanging forever. With
 * `signal`, a caller abort cancels the pending read immediately rather than
 * waiting for the next chunk.
 */
export async function* sseEvents(
  stream: ReadableStream<Uint8Array>,
  options: SseOptions = {},
): AsyncGenerator<string> {
  const { idleTimeoutMs, signal } = options;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await readWithGuard(reader, idleTimeoutMs, signal);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.startsWith("data:")) {
          yield line.slice(5).trimStart();
        }
      }
    }
    const tail = buffer.replace(/\r$/, "");
    if (tail.startsWith("data:")) {
      yield tail.slice(5).trimStart();
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Await a single read, racing it against the idle timeout and the abort
 * signal. On either, the reader is cancelled so the underlying connection is
 * released, then the matching error is raised.
 */
function readWithGuard(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("The run was aborted.", "AbortError"));
  }
  if (!idleTimeoutMs && !signal) {
    return reader.read();
  }
  return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void reader.cancel().catch(() => undefined);
      reject(error);
    };
    const onAbort = (): void => fail(new DOMException("The run was aborted.", "AbortError"));
    const timer = idleTimeoutMs
      ? setTimeout(
          () => fail(new StreamIdleError("OpenRouter stopped sending data (idle timeout).")),
          idleTimeoutMs,
        )
      : undefined;
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
