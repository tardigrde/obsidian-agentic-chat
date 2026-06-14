import { describe, expect, it } from "vitest";
import { DEFAULT_OUTPUT_STYLE, OUTPUT_STYLE_ORDER, OUTPUT_STYLES } from "../src/agent/output-styles";

describe("OUTPUT_STYLES", () => {
  it("orders every style with default first", () => {
    expect(OUTPUT_STYLE_ORDER[0]).toBe("default");
    expect(new Set(OUTPUT_STYLE_ORDER)).toEqual(new Set(Object.keys(OUTPUT_STYLES)));
  });

  it("only the default style is a no-op overlay", () => {
    expect(OUTPUT_STYLES[DEFAULT_OUTPUT_STYLE].promptOverlay).toBe("");
    expect(OUTPUT_STYLES.brainstorm.promptOverlay).not.toBe("");
    expect(OUTPUT_STYLES.learning.promptOverlay).not.toBe("");
  });
});
