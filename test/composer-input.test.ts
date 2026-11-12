import { describe, expect, it } from "vitest";
import {
  parseInlineInstruction,
  resolveComposerAction,
  restoreUndeliveredText,
  stripContextPreamble,
} from "../src/ui/composer-input";

describe("composer input helpers", () => {
  it("chooses one action for Enter and the toolbar button", () => {
    expect(resolveComposerAction("enter", false)).toBe("send");
    expect(resolveComposerAction("button", false)).toBe("send");
    expect(resolveComposerAction("enter", true)).toBe("steer");
    expect(resolveComposerAction("button", true)).toBe("queue");
  });

  it("parses inline standing instructions only from hash-prefixed input", () => {
    expect(parseInlineInstruction("# Prefer concise answers")).toBe("Prefer concise answers");
    expect(parseInlineInstruction("  # Prefer concise answers  ")).toBe("Prefer concise answers");
    expect(parseInlineInstruction("#   ")).toBeNull();
    expect(parseInlineInstruction("Use concise answers")).toBeNull();
  });

  it("strips one leading context preamble for retry display", () => {
    expect(stripContextPreamble("<context>\n[[A.md]]\n</context>\n\nAsk me")).toBe("Ask me");
    expect(stripContextPreamble("Ask me")).toBe("Ask me");
    // A user's own "Focus:" line after the context block is their text, not the hint.
    expect(stripContextPreamble("<context>\n[[A.md]]\n</context>\n\nFocus: my own line\n\nmore")).toBe("Focus: my own line\n\nmore");
    // The real hint goes; first-line indentation and CRLF prompts survive.
    expect(
      stripContextPreamble("<context>\n[[A.md]]\n</context>\n\nFocus: The user's request after this line is the primary task.\n\n    indented code"),
    ).toBe("    indented code");
    expect(stripContextPreamble("<context>\r\n[[A.md]]\r\n</context>\r\n\r\nFocus: The user's request after this line is the primary task.\r\n\r\nAsk me")).toBe("Ask me");
  });

  it("strips the unchanged-context marker for retry display", () => {
    expect(
      stripContextPreamble("<context unchanged since previous turn. Attached: [[A.md]]</context>\n\nAsk me"),
    ).toBe("Ask me");
  });

  it("restores undelivered steering text without the preamble and keeps the draft", () => {
    const steered = "<context>\n[[A.md]]\n</context>\n\nkeep citations strict";
    expect(restoreUndeliveredText("", [steered])).toBe("keep citations strict");
    expect(restoreUndeliveredText("half-typed draft\n", [steered, "and be brief"])).toBe(
      "half-typed draft\n\nkeep citations strict\n\nand be brief",
    );
    expect(restoreUndeliveredText("draft", ["  "])).toBeNull();
  });
});
