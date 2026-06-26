import { describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import {
  cacheHitPercent,
  describeCall,
  formatCost,
  formatElapsed,
  formatUsage,
  safeJson,
  shortModelLabel,
  truncateText,
} from "../src/ui/format";

describe("truncateText", () => {
  it("leaves short text untouched", () => {
    expect(truncateText("hello", 10)).toBe("hello");
  });
  it("cuts and appends an ellipsis past the limit", () => {
    expect(truncateText("hello world", 5)).toBe("hello…");
  });
});

describe("shortModelLabel", () => {
  it("drops the provider prefix from an OpenRouter slug", () => {
    expect(shortModelLabel("anthropic/claude-opus-4")).toBe("claude-opus-4");
  });
  it("keeps a variant suffix", () => {
    expect(shortModelLabel("deepseek/deepseek-chat-v3-0324:free")).toBe("deepseek-chat-v3-0324:free");
  });
  it("returns a bare id unchanged", () => {
    expect(shortModelLabel("llama3.1")).toBe("llama3.1");
  });
  it("trims surrounding whitespace", () => {
    expect(shortModelLabel("  openai/gpt-5  ")).toBe("gpt-5");
  });
  it("handles an empty string", () => {
    expect(shortModelLabel("")).toBe("");
  });
});

describe("describeCall", () => {
  it("captions a known tool with its path argument", () => {
    expect(describeCall("read", '{"path":"Notes/a.md"}')).toBe("Reading file: Notes/a.md");
  });
  it("prefers pattern, then newPath, when no path is present", () => {
    expect(describeCall("search", '{"query":"TODO"}')).toBe("Searching: TODO");
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

describe("formatElapsed", () => {
  it("shows sub-second durations in milliseconds", () => {
    expect(formatElapsed(0)).toBe("0ms");
    expect(formatElapsed(321.6)).toBe("322ms");
  });
  it("shows seconds with one decimal under a minute", () => {
    expect(formatElapsed(1000)).toBe("1.0s");
    expect(formatElapsed(12_500)).toBe("12.5s");
  });
  it("shows minutes and seconds past a minute", () => {
    expect(formatElapsed(65_000)).toBe("1m 5s");
    expect(formatElapsed(125_000)).toBe("2m 5s");
  });
  it("collapses negative or non-finite input to 0ms", () => {
    expect(formatElapsed(-50)).toBe("0ms");
    expect(formatElapsed(Number.NaN)).toBe("0ms");
  });
});

describe("cacheHitPercent", () => {
  const usage = (over: Partial<Usage>): Usage => ({ totalTokens: 0, ...over }) as Usage;

  it("is null until anything cacheable is billed (no 0% before a cached turn)", () => {
    expect(cacheHitPercent(usage({}))).toBeNull();
    expect(cacheHitPercent(usage({ input: 100 }))).toBe(0);
  });
  it("treats cacheRead as hits over the full prompt-token base", () => {
    // base = input + cacheRead + cacheWrite = 100 + 900 + 0 → 90% hit.
    expect(cacheHitPercent(usage({ input: 100, cacheRead: 900 }))).toBe(90);
  });
  it("folds cacheWrite into the base but not the numerator", () => {
    // base = 100 + 450 + 450 = 1000 → 45% hit.
    expect(cacheHitPercent(usage({ input: 100, cacheRead: 450, cacheWrite: 450 }))).toBe(45);
  });
  it("rounds to a whole percent", () => {
    expect(cacheHitPercent(usage({ input: 0, cacheRead: 1, cacheWrite: 2 }))).toBe(33);
  });
});

describe("formatUsage", () => {
  const usage = (over: Partial<Usage>): Usage => ({ totalTokens: 0, ...over }) as Usage;

  it("shows tokens only when there is no cost and no cache", () => {
    expect(formatUsage(usage({ totalTokens: 120 }))).toBe("120 tokens");
  });
  it("appends cost when present", () => {
    expect(formatUsage(usage({ totalTokens: 120, cost: { total: 0.5 } as Usage["cost"] }))).toBe(
      "120 tokens · $0.50",
    );
  });
  it("surfaces the prompt-cache hit ratio between tokens and cost", () => {
    expect(
      formatUsage(
        usage({ totalTokens: 1000, input: 100, cacheRead: 900, cost: { total: 0.02 } as Usage["cost"] }),
      ),
    ).toBe("1000 tokens · 90% cache · $0.02");
  });
});
