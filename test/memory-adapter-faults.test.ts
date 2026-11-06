import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "./helpers/memory-adapter";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("MemoryAdapter fault queue", () => {
  it("fails one write and then writes normally", async () => {
    const adapter = new MemoryAdapter();
    adapter.failNextWrite("a.txt", new Error("disk full"));

    await expect(adapter.write("a.txt", "first")).rejects.toThrow("disk full");
    expect(adapter.files.has("a.txt")).toBe(false);

    await adapter.write("a.txt", "second");
    expect(adapter.files.get("a.txt")).toBe("second");
  });

  it("delays one read until the gate opens", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write("a.txt", "content");
    const gate = deferred();
    adapter.delayNextRead("a.txt", gate.promise);

    let settled = false;
    const read = adapter.read("a.txt").finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.resolve();
    await expect(read).resolves.toBe("content");
    expect(settled).toBe(true);
  });

  it("fails one append without losing the existing content", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write("a.txt", "keep\n");
    adapter.failNextAppend("a.txt", new Error("read only"));

    await expect(adapter.append("a.txt", "lost\n")).rejects.toThrow("read only");
    expect(adapter.files.get("a.txt")).toBe("keep\n");
  });

  it("throws ENOENT once and then reads the file", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write("a.txt", "content");
    const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    adapter.failNextRead("a.txt", enoent);

    await expect(adapter.read("a.txt")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(adapter.read("a.txt")).resolves.toBe("content");
  });
});
