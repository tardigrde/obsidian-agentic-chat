import { describe, expect, it } from "vitest";
import { sseEvents } from "../src/llm/sse";

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
});
