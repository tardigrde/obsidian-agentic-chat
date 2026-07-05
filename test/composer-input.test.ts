import { describe, expect, it } from "vitest";
import { parseInlineInstruction, parseStreamingSteering, stripContextPreamble } from "../src/ui/composer-input";

describe("composer input helpers", () => {
  it("parses streaming steering commands and trims their payload", () => {
    expect(parseStreamingSteering("/steer  focus on tests ")).toEqual({ mode: "steer", text: "focus on tests" });
    expect(parseStreamingSteering("/redirect use the smaller design")).toEqual({
      mode: "redirect",
      text: "use the smaller design",
    });
    expect(parseStreamingSteering("/followup continue")).toEqual({ mode: "follow-up", text: "continue" });
    expect(parseStreamingSteering("/follow-up continue")).toEqual({ mode: "follow-up", text: "continue" });
  });

  it("rejects empty or unrelated steering input", () => {
    expect(parseStreamingSteering("/steer   ")).toBeNull();
    expect(parseStreamingSteering("/status")).toBeNull();
    expect(parseStreamingSteering("plain prompt")).toBeNull();
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
