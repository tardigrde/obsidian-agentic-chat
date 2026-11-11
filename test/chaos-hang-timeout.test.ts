import { describe, expect, it, vi } from "vitest";
import { DriverHang, withHangTimeout } from "../scripts/chaos/hang-timeout";

describe("chaos hang timeout", () => {
  it("returns the work's value when it answers in time", async () => {
    await expect(withHangTimeout(Promise.resolve(7), 1_000, "observe x001")).resolves.toBe(7);
  });

  it("rejects with DriverHang when Obsidian never answers", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<never>(() => {});
      const result = withHangTimeout(never, 90_000, "observe x091");
      const check = expect(result).rejects.toThrow(new DriverHang("observe x091 got no answer from Obsidian in 90s"));
      await vi.advanceTimersByTimeAsync(90_000);
      await check;
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a real failure through unchanged, not as a hang", async () => {
    const error = await withHangTimeout(Promise.reject(new Error("ref w0e2 is gone")), 1_000, "click x004").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DriverHang);
  });
});
