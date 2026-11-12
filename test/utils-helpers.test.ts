import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/utils/errors";
import { asRecord, isRecord } from "../src/utils/records";

describe("errorMessage", () => {
  it("returns the message of an Error", () => {
    expect(errorMessage(new Error("x"))).toBe("x");
  });

  it("returns a thrown string unchanged", () => {
    expect(errorMessage("s")).toBe("s");
  });

  it("stringifies a non-Error value", () => {
    expect(errorMessage(42)).toBe("42");
  });

  it("stringifies undefined", () => {
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("isRecord", () => {
  it("accepts a plain object", () => {
    expect(isRecord({})).toBe(true);
  });

  it("rejects an array", () => {
    expect(isRecord([])).toBe(false);
  });

  it("rejects null", () => {
    expect(isRecord(null)).toBe(false);
  });

  it("rejects a primitive", () => {
    expect(isRecord("a")).toBe(false);
  });
});

describe("asRecord", () => {
  it("returns {} for null", () => {
    expect(asRecord(null)).toEqual({});
  });

  it("returns {} for an array", () => {
    expect(asRecord([1])).toEqual({});
  });

  it("returns {} for a falsy primitive", () => {
    expect(asRecord(0)).toEqual({});
  });

  it("returns the same object reference", () => {
    const obj = { a: 1 };
    expect(asRecord(obj)).toBe(obj);
  });
});
