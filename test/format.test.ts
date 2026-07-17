import { describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import {
  cacheHitPercent,
  callPath,
  describeCall,
  formatArgsReadable,
  formatCallBody,
  formatCost,
  formatDetailedUsage,
  formatElapsed,
  formatUsage,
  formatUsageDelta,
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

describe("formatArgsReadable", () => {
  it("returns empty for empty or {} args so the caller omits the section", () => {
    expect(formatArgsReadable("{}")).toBe("");
    expect(formatArgsReadable('{"a":null,"b":""}')).toBe("");
  });
  it("returns empty for malformed JSON", () => {
    expect(formatArgsReadable("not json")).toBe("");
  });
  it("returns empty for non-object JSON (null, array, string, number)", () => {
    expect(formatArgsReadable("null")).toBe("");
    expect(formatArgsReadable("[]")).toBe("");
    expect(formatArgsReadable('"value"')).toBe("");
    expect(formatArgsReadable("42")).toBe("");
  });
  it("renders each arg as a readable key: value line", () => {
    expect(formatArgsReadable('{"path":"Notes/a.md","limit":10}')).toBe("path: Notes/a.md\nlimit: 10");
  });
  it("stringifies non-string values compactly", () => {
    expect(formatArgsReadable('{"kinds":["a","b"]}')).toBe('kinds: ["a","b"]');
  });
  it("collapses whitespace and truncates long values to one line", () => {
    const long = "x".repeat(300);
    const out = formatArgsReadable(`{"oldText":"${long}"}`);
    expect(out).toHaveLength("oldText: ".length + 160 + 1); // 160-char cap + ellipsis
    expect(out.endsWith("…")).toBe(true);
    expect(out.includes("\n")).toBe(false);
  });
});

describe("formatCallBody", () => {
  it("renders an edit as path + edit count, never the raw oldText/newText", () => {
    const args = JSON.stringify({
      path: "Notes/a.md",
      edits: [{ oldText: "x".repeat(500), newText: "y".repeat(500) }, { oldText: "a", newText: "b" }],
    });
    expect(formatCallBody("edit", args)).toBe("path: Notes/a.md\n2 edits");
  });
  it("renders a read as path + line range when present", () => {
    expect(formatCallBody("read", '{"path":"Notes/a.md","offset":10,"limit":5}')).toBe("path: Notes/a.md\nlines: 10–15");
    expect(formatCallBody("read", '{"path":"Notes/a.md"}')).toBe("path: Notes/a.md");
  });
  it("falls back to readable key:value lines for other tools", () => {
    expect(formatCallBody("search", '{"query":"TODO"}')).toBe("query: TODO");
  });
  it("tolerates malformed JSON", () => {
    expect(formatCallBody("edit", "not json")).toBe("");
  });
  it("returns empty for non-object JSON", () => {
    expect(formatCallBody("edit", "null")).toBe("");
    expect(formatCallBody("edit", "[]")).toBe("");
    expect(formatCallBody("edit", "42")).toBe("");
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

describe("callPath", () => {
  it("extracts path from tool args", () => {
    expect(callPath('{"path":"Notes/a.md"}')).toBe("Notes/a.md");
    expect(callPath('{"newPath":"Notes/b.md"}')).toBe("Notes/b.md");
  });
  it("returns empty for missing or invalid args", () => {
    expect(callPath("{}")).toBe("");
    expect(callPath("not json")).toBe("");
  });
  it("returns empty for non-object JSON", () => {
    expect(callPath("null")).toBe("");
    expect(callPath("[]")).toBe("");
    expect(callPath('"string"')).toBe("");
    expect(callPath("42")).toBe("");
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
  it("group-thousands the token total so it stops reading as noise", () => {
    expect(formatUsage(usage({ totalTokens: 3327418 }))).toBe("3,327,418 tokens");
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
    ).toBe("1,000 tokens · 90% cache · $0.02");
  });
});

describe("formatUsageDelta", () => {
  const usage = (over: Partial<Usage>): Usage => ({ totalTokens: 0, ...over }) as Usage;

  it("delegates to formatUsage (usage is per-response, not cumulative)", () => {
    expect(formatUsageDelta(usage({ totalTokens: 120 }))).toBe("120 tokens");
    expect(formatUsageDelta(usage({ totalTokens: 50, cacheRead: 50 }), usage({ totalTokens: 100 }))).toBe("50 tokens · 100% cache");
  });
});

describe("formatDetailedUsage", () => {
  const usage = (over: Partial<Usage>): Usage => ({ totalTokens: 0, ...over }) as Usage;

  it("renders an active-session token and cache breakdown with human-readable numbers", () => {
    expect(
      formatDetailedUsage(
        usage({
          input: 990_000,
          output: 310_000,
          cacheRead: 3_100_000,
          cacheWrite: 30_000,
          totalTokens: 4_430_000,
        }),
        { includesCompactedUsage: true, includesSubagentUsage: true },
      ),
    ).toEqual([
      ["Scope", "Active session, including compacted carried usage and subagent usage"],
      ["Total tokens", "4.43M"],
      ["Prompt tokens", "4.12M"],
      ["Fresh input", "990k"],
      ["Cache read", "3.10M"],
      ["Cache write", "30k"],
      ["Output tokens", "310k"],
      ["Prompt cache hit", "75% of prompt tokens in this session"],
      ["Cost", "not reported by provider"],
    ]);
  });

  it("distinguishes reported zero cost from missing cost", () => {
    expect(
      formatDetailedUsage(usage({ totalTokens: 100, cost: { total: 0 } as Usage["cost"] })).at(-1),
    ).toEqual(["Cost", "$0.00"]);
    expect(formatDetailedUsage(usage({ totalTokens: 100 })).at(-1)).toEqual(["Cost", "not reported by provider"]);
  });
});
