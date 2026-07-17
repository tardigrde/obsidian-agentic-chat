import { describe, expect, it } from "vitest";
import { applyExactEdits, applyExactEditsPartial } from "../src/vault/edit";

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

  it("rejects a no-op edit where oldText equals newText", () => {
    expect(() => applyExactEdits("abc", [{ oldText: "abc", newText: "abc" }])).toThrow(/no change/);
  });

  it("includes closest-line hint when oldText is not found", () => {
    const content = "alpha beta gamma\ndelta epsilon zeta";
    expect(() => applyExactEdits(content, [{ oldText: "beta gammax", newText: "X" }])).toThrow(/Closest match.*beta gamma/);
  });

  it("includes second-closest line hint when score is meaningful", () => {
    const content = "The quick brown fox\nThe quick red fox jumps\nSomething else entirely";
    expect(() => applyExactEdits(content, [{ oldText: "The quick brown foxes", newText: "X" }])).toThrow(
      /Next closest/,
    );
  });

  it("omits fuzzy hint when no tokens overlap", () => {
    const content = "alpha beta gamma";
    expect(() => applyExactEdits(content, [{ oldText: "zzz", newText: "X" }])).not.toThrow(/Closest match/);
  });
});

describe("applyExactEdits — redacted-placeholder fallback", () => {
  it("matches an [EMAIL]-redacted oldText against the real email", () => {
    const content = "| 2 | [Alex](mailto:szvirida.alex@gmail.com) | x |";
    const oldText = "| 2 | [Alex](mailto:[EMAIL]) | x |";
    expect(applyExactEdits(content, [{ oldText, newText: "| 2 | [Alex](mailto:foo@bar.com) | y |" }])).toBe(
      "| 2 | [Alex](mailto:foo@bar.com) | y |",
    );
  });

  it("still prefers exact match when oldText is byte-identical", () => {
    expect(applyExactEdits("a@b.co", [{ oldText: "a@b.co", newText: "x" }])).toBe("x");
  });

  it("throws when a placeholder oldText matches multiple times", () => {
    const content = "mailto:a@b.co and mailto:c@d.co";
    expect(() => applyExactEdits(content, [{ oldText: "mailto:[EMAIL]", newText: "x" }])).toThrow(/matches 2 times/);
  });

  it("matches [PHONE]-redacted oldText against real phone number", () => {
    const content = "Call +1 (555) 123-4567 now";
    expect(applyExactEdits(content, [{ oldText: "Call [PHONE] now", newText: "Text them now" }])).toBe(
      "Text them now",
    );
  });

  it("substitutes real email into newText when newText also contains [EMAIL]", () => {
    const content = "Contact us at support@company.com for details.";
    const result = applyExactEdits(content, [
      { oldText: "Contact us at [EMAIL] for details.", newText: "Contact us at [EMAIL] for help." },
    ]);
    expect(result).toBe("Contact us at support@company.com for help.");
    expect(result).not.toContain("[EMAIL]");
  });

  it("substitutes real phone into newText when newText also contains [PHONE]", () => {
    const content = "Call +1 (555) 123-4567 now";
    const result = applyExactEdits(content, [
      { oldText: "Call [PHONE] now", newText: "Reach [PHONE] today" },
    ]);
    expect(result).toBe("Reach +1 (555) 123-4567 today");
    expect(result).not.toContain("[PHONE]");
  });

  it("matches [REDACTED]-redacted oldText against arbitrary content", () => {
    const content = "secret: hello world end";
    expect(applyExactEdits(content, [{ oldText: "secret: [REDACTED] end", newText: "gone" }])).toBe("gone");
  });
});

describe("applyExactEditsPartial", () => {
  it("applies the matching edits and reports the failures", () => {
    const content = "alpha beta gamma";
    const result = applyExactEditsPartial(content, [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "missing", newText: "X" },
      { oldText: "gamma", newText: "GAMMA" },
    ]);
    expect(result.content).toBe("ALPHA beta GAMMA");
    expect(result.applied).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/not found/);
  });

  it("returns content unchanged with all failures when nothing matches", () => {
    const result = applyExactEditsPartial("abc", [{ oldText: "x", newText: "y" }]);
    expect(result.content).toBe("abc");
    expect(result.applied).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
  });

  it("drops an overlapping resolved edit as a failure", () => {
    const content = "alpha beta gamma";
    const result = applyExactEditsPartial(content, [
      { oldText: "beta", newText: "B" },
      { oldText: "ta gamma", newText: "X" },
    ]);
    expect(result.applied).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/overlap/);
  });

  it("applies a redacted-placeholder edit within a partial batch", () => {
    const content = "row [Alex](mailto:a@b.co) end";
    const result = applyExactEditsPartial(content, [
      { oldText: "[Alex](mailto:[EMAIL])", newText: "[Alex](mailto:x@y.com)" },
      { oldText: "end", newText: "END" },
    ]);
    expect(result.applied).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.content).toBe("row [Alex](mailto:x@y.com) END");
  });

  it("requires at least one edit", () => {
    expect(() => applyExactEditsPartial("abc", [])).toThrow(/At least one/);
  });
});

describe("B3d — regression: md roster table with mailto links", () => {
  const ROSTER = [
    "| # | Name | Role |",
    "|---|------|------|",
    "| 1 | [Alice](mailto:alice@example.com) | Lead |",
    "| 2 | [Bob](mailto:bob@corp.io) | Dev |",
    "| 3 | [Charlie](mailto:charlie@work.org) | QA |",
  ].join("\n");

  it("edits a mailto row using [EMAIL] placeholder (first-try success)", () => {
    const result = applyExactEdits(ROSTER, [
      {
        oldText: "| 2 | [Bob](mailto:[EMAIL]) | Dev |",
        newText: "| 2 | [Robert](mailto:bob@corp.io) | Senior Dev |",
      },
    ]);
    expect(result).toContain("| 2 | [Robert](mailto:bob@corp.io) | Senior Dev |");
    expect(result).toContain("| 1 | [Alice](mailto:alice@example.com) | Lead |");
  });

  it("batch-edits multiple mailto rows via partial apply", () => {
    const result = applyExactEditsPartial(ROSTER, [
      {
        oldText: "| 1 | [Alice](mailto:[EMAIL]) | Lead |",
        newText: "| 1 | [Alice](mailto:alice@example.com) | Director |",
      },
      {
        oldText: "| 3 | [Charlie](mailto:[EMAIL]) | QA |",
        newText: "| 3 | [Charlie](mailto:charlie@work.org) | Senior QA |",
      },
    ]);
    expect(result.applied).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(result.content).toContain("Director");
    expect(result.content).toContain("Senior QA");
  });

  it("partial-apply succeeds for good rows and reports the bad row", () => {
    const result = applyExactEditsPartial(ROSTER, [
      {
        oldText: "| 1 | [Alice](mailto:[EMAIL]) | Lead |",
        newText: "| 1 | [Alice](mailto:alice@example.com) | Director |",
      },
      {
        oldText: "| 99 | [Ghost](mailto:[EMAIL]) | None |",
        newText: "| 99 | [Ghost](mailto:ghost@x.com) | Real |",
      },
    ]);
    expect(result.applied).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].error).toMatch(/not found/);
    expect(result.content).toContain("Director");
    expect(result.content).not.toContain("Ghost");
  });

  it("preserves real email when both oldText and newText use [EMAIL] placeholder", () => {
    const result = applyExactEdits(ROSTER, [
      {
        oldText: "| 2 | [Bob](mailto:[EMAIL]) | Dev |",
        newText: "| 2 | [Bob](mailto:[EMAIL]) | Senior Dev |",
      },
    ]);
    expect(result).toContain("| 2 | [Bob](mailto:bob@corp.io) | Senior Dev |");
    expect(result).not.toContain("[EMAIL]");
  });
});
