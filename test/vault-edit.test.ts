import { describe, expect, it } from "vitest";
import { applyExactEdits } from "../src/vault/edit";

describe("applyExactEdits", () => {
  it("applies a single exact replacement", () => {
    expect(applyExactEdits("hello world", [{ oldText: "world", newText: "vault" }])).toBe("hello vault");
  });

  it("applies multiple non-overlapping edits in order", () => {
    const result = applyExactEdits("one two three", [
      { oldText: "three", newText: "3" },
      { oldText: "one", newText: "1" },
    ]);
    expect(result).toBe("1 two 3");
  });

  it("throws when oldText is not found", () => {
    expect(() => applyExactEdits("abc", [{ oldText: "xyz", newText: "1" }])).toThrow(/not found/);
  });

  it("throws when oldText matches more than once", () => {
    expect(() => applyExactEdits("a a", [{ oldText: "a", newText: "b" }])).toThrow(/exactly once/);
  });

  it("throws when edits overlap", () => {
    expect(() =>
      applyExactEdits("abcdef", [
        { oldText: "abcd", newText: "X" },
        { oldText: "cdef", newText: "Y" },
      ]),
    ).toThrow(/overlap/);
  });

  it("requires at least one edit", () => {
    expect(() => applyExactEdits("abc", [])).toThrow(/At least one/);
  });
});
