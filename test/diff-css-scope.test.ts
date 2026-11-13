import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function diffLineSelectors(): string[] {
  const selectors: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{/g)) {
    for (const part of match[1].split(",")) {
      const selector = part.trim().replace(/\s+/g, " ");
      if (selector.includes("diff-line")) selectors.push(selector);
    }
  }
  return selectors;
}

describe("diff line CSS scope", () => {
  it("gives each diff renderer its own class and defines no diff-line selector twice", () => {
    const selectors = diffLineSelectors();
    const duplicates = selectors.filter((selector, index) => selectors.indexOf(selector) !== index);
    expect(duplicates).toEqual([]);

    const allowed =
      /^\.agentic-chat-(step-diff-line|approval-diff-line|quick-ask-diff-line)(?:\.is-(?:add|remove|del|context))?$/;
    for (const selector of selectors) {
      expect(selector, selector).toMatch(allowed);
    }
  });
});
