import { describe, expect, it } from "vitest";
import { isPinnedToBottom } from "../src/ui/scroll-pinning";

describe("isPinnedToBottom", () => {
  it("treats non-scrollable content as pinned", () => {
    expect(isPinnedToBottom({ scrollHeight: 100, clientHeight: 120, scrollTop: 0 })).toBe(true);
  });

  it("is pinned when close to the bottom threshold", () => {
    expect(isPinnedToBottom({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 570 })).toBe(true);
  });

  it("is not pinned once the user has scrolled away from the bottom", () => {
    expect(isPinnedToBottom({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 100 })).toBe(false);
  });

  it("uses a caller-provided threshold", () => {
    const metrics = { scrollHeight: 1_000, clientHeight: 400, scrollTop: 550 };
    expect(isPinnedToBottom(metrics, 40)).toBe(false);
    expect(isPinnedToBottom(metrics, 60)).toBe(true);
  });
});
