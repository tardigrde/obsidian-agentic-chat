import { describe, expect, it } from "vitest";
import { StreamIdleError, sseEvents } from "../src/llm/sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const event of sseEvents(stream)) out.push(event);
  return out;
}

describe("sseEvents", () => {
  it("parses simple data events", async () => {
    expect(await collect(streamOf(["data: one\n\ndata: two\n\n"]))).toEqual(["one", "two"]);
  });

  it("handles events split across chunk boundaries", async () => {
    expect(await collect(streamOf(["data: hel", "lo\ndata: wor", "ld\n"]))).toEqual([
      "hello",
      "world",
    ]);
  });

  it("strips carriage returns from CRLF streams", async () => {
    expect(await collect(streamOf(["data: a\r\n\r\ndata: b\r\n"]))).toEqual(["a", "b"]);
  });

  it("ignores comment keep-alive lines", async () => {
    expect(
      await collect(streamOf([": OPENROUTER PROCESSING\n\ndata: x\n\n: ping\n"])),
    ).toEqual(["x"]);
  });

  it("yields a trailing event without a final newline", async () => {
    expect(await collect(streamOf(["data: tail"]))).toEqual(["tail"]);
  });

  it("passes through the [DONE] sentinel", async () => {
    expect(await collect(streamOf(["data: {}\n\ndata: [DONE]\n\n"]))).toEqual(["{}", "[DONE]"]);
  });

  it("raises StreamIdleError when the body stalls past the idle timeout", async () => {
    const stalling = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        // Never enqueues again and never closes: the stream goes silent.
      },
    });
    const received: string[] = [];

    await expect(
      (async () => {
        for await (const event of sseEvents(stalling, { idleTimeoutMs: 20 })) {
          received.push(event);
        }
      })(),
    ).rejects.toBeInstanceOf(StreamIdleError);
    expect(received).toEqual(["first"]);
  });

  it("aborts the read promptly when the signal fires", async () => {
    const controller = new AbortController();
    const stalling = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: hi\n\n"));
      },
    });
    const pending = (async () => {
      for await (const _event of sseEvents(stalling, { signal: controller.signal })) {
        controller.abort();
      }
    })();

    await expect(pending).rejects.toThrow(/abort/i);
  });

  it("does not time out a healthy stream that keeps sending", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const word of ["a", "b", "c"]) {
          controller.enqueue(encoder.encode(`data: ${word}\n\n`));
          await new Promise((r) => setTimeout(r, 5));
        }
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const event of sseEvents(stream, { idleTimeoutMs: 100 })) out.push(event);

    expect(out).toEqual(["a", "b", "c"]);
  });
});
