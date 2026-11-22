import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALLOWLIST, checkCssTokens, declarations } from "../scripts/check-css-tokens.mjs";

const styles = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

describe("css token rule", () => {
  it("styles.css uses only --ac-* tokens outside the token layer, with an empty allowlist", () => {
    expect(ALLOWLIST).toEqual([]);
    expect(checkCssTokens(styles)).toEqual([]);
    expect(declarations(styles).length).toBeGreaterThan(500);
  });

  it("fails on a raw hex colour, a px length, and an Obsidian variable in a component rule", () => {
    const errors = checkCssTokens(`
      .agentic-chat-x {
        color: #ff0000;
        padding: 8px;
        background: var(--background-primary);
        border: 1px solid rgba(0, 0, 0, 0.1);
      }
    `);
    expect(errors.join("\n")).toMatch(/color: #ff0000 }: raw colour/);
    expect(errors.join("\n")).toMatch(/padding: 8px }: px length/);
    expect(errors.join("\n")).toMatch(/background: var\(--background-primary\) }: Obsidian variable/);
    expect(errors.filter((error) => error.includes("border:"))).toHaveLength(2);
  });

  it("fails on a :has() selector (the community-plugin scan warns on it)", () => {
    const errors = checkCssTokens(`.a:has(.b:placeholder-shown) .c { opacity: 0.5; }`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/:has selector/);
    expect(checkCssTokens(`.a.is-empty .c { opacity: 0.5; }`)).toEqual([]);
  });

  it("allows raw values in --ac-* declarations, in media queries, and inside comments", () => {
    expect(
      checkCssTokens(`
        /* a comment may say #fff or 12px */
        .agentic-chat-view { --ac-space-2: 8px; --ac-accent: var(--interactive-accent); --ac-x: #000; }
        @media (max-width: 400px) { .agentic-chat-x { padding: var(--ac-space-2); } }
        .agentic-chat-y { color: var(--ac-accent); width: 100%; transition: opacity 160ms; }
      `),
    ).toEqual([]);
  });

  it("does not take a named colour inside a longer word", () => {
    expect(checkCssTokens(".x { animation: agentic-chat-red-pulse 1s; color: currentColor; }")).toEqual([]);
    expect(checkCssTokens(".x { color: white; }")).toHaveLength(1);
  });

  it("catches every named colour in any case, but allows transparent and currentColor", () => {
    expect(checkCssTokens(".x { color: Crimson; }")).toHaveLength(1);
    expect(checkCssTokens(".x { border-color: Teal; }")).toHaveLength(1);
    expect(checkCssTokens(".x { background: transparent; color: currentColor; }")).toEqual([]);
  });

  it("allows only --ac-* variables in component rules (any Obsidian variable is caught)", () => {
    expect(checkCssTokens(".x { color: var(--link-color); }").join("\n")).toMatch(/Obsidian variable/);
    expect(checkCssTokens(".x { background: var(--code-background); }")).toHaveLength(1);
    expect(checkCssTokens(".x { color: var(--ac-accent, var(--accent-h)); }")).toHaveLength(1);
  });

  it("checks declarations in at-rule blocks and keeps a quoted ; inside one value", () => {
    expect(checkCssTokens("@font-face { font-family: x; size-adjust: 3px; }")).toHaveLength(1);
    const uri = `.x { background-image: url("data:image/svg+xml;utf8,<path fill='#f00'/>"); }`;
    expect(checkCssTokens(uri).join("\n")).toMatch(/raw colour/);
  });
});
