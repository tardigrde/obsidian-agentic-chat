import { describe, expect, it } from "vitest";
import {
  parseInlineInstruction,
  resolveComposerAction,
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
  });
});
