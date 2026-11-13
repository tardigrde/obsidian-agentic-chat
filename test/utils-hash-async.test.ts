import { afterEach, describe, expect, it, vi } from "vitest";
import { fnv1a32 } from "../src/utils/hash";
import { withTimeout } from "../src/utils/async";

describe("fnv1a32", () => {
  it("matches the published FNV-1a 32-bit vectors", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("hashes code units by default and code points on request", () => {
    // Identical inside the BMP; different for a surrogate pair.
    expect(fnv1a32("abc", { codePoints: true })).toBe(fnv1a32("abc"));
    expect(fnv1a32("😀", { codePoints: true })).not.toBe(fnv1a32("😀"));
  });
});

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears its timer when the promise settles first", async () => {
    vi.useFakeTimers();
    await expect(withTimeout(Promise.resolve("ok"), 5_000)).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with the caller's error when the timer wins", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => undefined), 100, () => new Error("too slow"));
    const assertion = expect(pending).rejects.toThrow("too slow");
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
  });
});
