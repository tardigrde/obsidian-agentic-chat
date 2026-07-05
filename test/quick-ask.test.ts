import { describe, expect, it } from "vitest";
import {
  applyQuickAskInstruction,
  buildQuickAskProposal,
  buildQuickAskTarget,
  type QuickAskEditorLike,
} from "../src/ui/quick-ask";

function editor(options: {
  text: string;
  selection?: string;
  from?: { line: number; ch: number };
  to?: { line: number; ch: number };
  cursor?: { line: number; ch: number };
}): QuickAskEditorLike {
  return {
    getSelection: () => options.selection ?? "",
    getCursor: (which?: "from" | "to") => {
      if (which === "from") return options.from ?? { line: 0, ch: 0 };
      if (which === "to") return options.to ?? { line: 0, ch: options.selection?.length ?? 0 };
      return options.cursor ?? { line: 0, ch: 0 };
    },
    getLine: (line: number) => options.text.split("\n")[line] ?? "",
  };
}

describe("buildQuickAskTarget", () => {
  it("targets the selected editor range when text is selected", () => {
    expect(
      buildQuickAskTarget(
        editor({
          text: "alpha beta",
          selection: "beta",
          from: { line: 0, ch: 6 },
          to: { line: 0, ch: 10 },
        }),
        "Note.md",
      ),
    ).toEqual({
      kind: "selection",
      text: "beta",
      from: { line: 0, ch: 6 },
      to: { line: 0, ch: 10 },
      path: "Note.md",
    });
  });

  it("falls back to the current line when there is no selection", () => {
    expect(buildQuickAskTarget(editor({ text: "first\nsecond", cursor: { line: 1, ch: 3 } }))).toEqual({
      kind: "line",
      text: "second",
      from: { line: 1, ch: 0 },
      to: { line: 1, ch: 6 },
      path: undefined,
    });
  });
});

describe("applyQuickAskInstruction", () => {
  it("supports deterministic rewrite instructions", () => {
    expect(applyQuickAskInstruction("alpha", "uppercase")).toBe("ALPHA");
    expect(applyQuickAskInstruction("ALPHA", "lowercase")).toBe("alpha");
    expect(applyQuickAskInstruction("alpha beta", "title case")).toBe("Alpha Beta");
    expect(applyQuickAskInstruction("  alpha  \n beta ", "trim whitespace")).toBe("alpha\nbeta");
    expect(applyQuickAskInstruction("alpha\nbeta", "bullet list")).toBe("- alpha\n- beta");
    expect(applyQuickAskInstruction("alpha\nbeta", "numbered list")).toBe("1. alpha\n2. beta");
    expect(applyQuickAskInstruction("alpha", "append: beta")).toBe("alpha\nbeta");
    expect(applyQuickAskInstruction("alpha", "replace: beta")).toBe("beta");
  });

  it("returns null for unsupported instructions", () => {
    expect(applyQuickAskInstruction("alpha", "make this more exciting")).toBeNull();
  });
});

describe("buildQuickAskProposal", () => {
  it("returns a proposed replacement with diff inputs", () => {
    const target = buildQuickAskTarget(editor({ text: "alpha beta", selection: "alpha" }), "Note.md");

    expect(buildQuickAskProposal(target, "uppercase")).toEqual({
      target,
      instruction: "uppercase",
      replacement: "ALPHA",
      summary: "Selection edit",
    });
  });

  it("does not propose a no-op edit", () => {
    const target = buildQuickAskTarget(editor({ text: "ALPHA", selection: "ALPHA" }), "Note.md");

    expect(buildQuickAskProposal(target, "uppercase")).toBeNull();
  });
});
