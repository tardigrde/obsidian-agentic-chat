import { describe, expect, it } from "vitest";
import { keyboardOverlap } from "../../src/ui/keyboard-overlap";

describe("keyboard overlap (phone drawer)", () => {
  it("counts only the part of the view the keyboard covers", () => {
    // Owner phone readout: view bottom 704, app container bottom 504 (812 - 308 keyboard).
    expect(keyboardOverlap(704, 504)).toBe(200);
  });

  it("is 0 when the keyboard is closed or the view already shrank", () => {
    expect(keyboardOverlap(704, 812)).toBe(0);
    expect(keyboardOverlap(504, 504)).toBe(0);
  });

  it("is 0 when a number is missing", () => {
    expect(keyboardOverlap(Number.NaN, 504)).toBe(0);
    expect(keyboardOverlap(704, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
