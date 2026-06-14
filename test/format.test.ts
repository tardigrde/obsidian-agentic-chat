import { describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import { describeCall, formatCost, formatUsage, safeJson, truncateText } from "../src/ui/format";

describe("truncateText", () => {
  it("leaves short text untouched", () => {
    expect(truncateText("hello", 10)).toBe("hello");
  });
  it("cuts and appends an ellipsis past the limit", () => {
    expect(truncateText("hello world", 5)).toBe("hello…");
  });
});

describe("describeCall", () => {
  it("captions a known tool with its path argument", () => {
    expect(describeCall("read", '{"path":"Notes/a.md"}')).toBe("Reading file: Notes/a.md");
  });
  it("prefers pattern, then newPath, when no path is present", () => {
    expect(describeCall("grep", '{"pattern":"TODO"}')).toBe("Searching: TODO");
    expect(describeCall("rename", '{"newPath":"b.md"}')).toBe("Renaming: b.md");
  });
  it("falls back to a generic label for unknown tools", () => {
    expect(describeCall("mystery", "{}")).toBe("Running mystery");
  });
  it("tolerates malformed JSON args", () => {
    expect(describeCall("read", "not json")).toBe("Reading file");
  });
});

describe("safeJson", () => {
  it("serialises plain values", () => {
    expect(safeJson({ a: 1 })).toBe('{"a":1}');
  });
  it("returns {} for circular structures", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(safeJson(cyclic)).toBe("{}");
  });
  it("returns {} for nullish", () => {
    expect(safeJson(undefined)).toBe("{}");
  });
});

describe("formatCost", () => {
  it("shows zero as $0.00", () => {
    expect(formatCost(0)).toBe("$0.00");
  });
  it("uses 4 decimals for sub-cent amounts", () => {
    expect(formatCost(0.0012)).toBe("$0.0012");
  });
  it("uses 2 decimals at or above a cent", () => {
    expect(formatCost(1.234)).toBe("$1.23");
  });
  it("collapses negative or non-finite input to $0.00", () => {
    expect(formatCost(-0.005)).toBe("$0.00");
    expect(formatCost(Number.NaN)).toBe("$0.00");
  });
});

describe("formatUsage", () => {
  const usage = (over: Partial<Usage>): Usage => ({ totalTokens: 0, ...over }) as Usage;

  it("shows tokens only when there is no cost", () => {
    expect(formatUsage(usage({ totalTokens: 120 }))).toBe("120 tokens");
  });
  it("appends cost when present", () => {
    expect(formatUsage(usage({ totalTokens: 120, cost: { total: 0.5 } as Usage["cost"] }))).toBe(
      "120 tokens · $0.50",
    );
  });
});
