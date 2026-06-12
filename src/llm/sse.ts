/**
 * Incremental Server-Sent Events parser.
 *
 * Yields the payload of every `data:` line, handling chunk boundaries that
 * split lines, CRLF endings, and comment lines (`: keep-alive`) that
 * OpenRouter sends while a request is queued.
 */
export async function* sseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
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
