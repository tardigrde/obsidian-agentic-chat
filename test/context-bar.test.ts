import { describe, expect, it } from "vitest";
import { contextLevel, contextPercent } from "../src/ui/context-bar";

describe("contextLevel", () => {
  it("is ok below 75%", () => {
    expect(contextLevel(0)).toBe("ok");
    expect(contextLevel(0.5)).toBe("ok");
    expect(contextLevel(0.749)).toBe("ok");
  });
  it("warns from 75% up to 90%", () => {
    expect(contextLevel(0.75)).toBe("warn");
    expect(contextLevel(0.89)).toBe("warn");
  });
  it("is high at 90% and above", () => {
    expect(contextLevel(0.9)).toBe("high");
    expect(contextLevel(1)).toBe("high");
  });
});

describe("contextPercent", () => {
  it("rounds to an integer percentage", () => {
    expect(contextPercent(0.123)).toBe(12);
    expect(contextPercent(0.756)).toBe(76);
  });
  it("clamps to 0–100", () => {
    expect(contextPercent(-1)).toBe(0);
    expect(contextPercent(0)).toBe(0);
    expect(contextPercent(1.5)).toBe(100);
    expect(contextPercent(Number.NaN)).toBe(0);
  });
});
