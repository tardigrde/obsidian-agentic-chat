#!/usr/bin/env node
/* eslint-disable no-console -- CLI checker prints its findings. */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * The CSS token rule (UI v2). Every colour, pixel size, and Obsidian theme
 * variable lives in the `--ac-*` token layer. Component rules use only `--ac-*`
 * tokens, so one block decides how the plugin looks under every theme.
 *
 * A declaration whose property is an `--ac-*` custom property is the token
 * layer: it may hold raw values and Obsidian variables. Every other declaration
 * may not hold:
 *   - a raw colour: `#hex`, `rgb()`, `rgba()`, `hsl()`, `hsla()`, or a named colour
 *   - a `px` length
 *   - an Obsidian theme variable (`--background-*`, `--text-*`, `--color-*`,
 *     `--interactive-*`, `--size-*`, `--radius-*`, `--font-*`, `--shadow-*`)
 *
 * Media and container query preludes may use `px` (CSS variables do not work
 * there). The allowlist is empty and stays empty: fix the rule, not the list.
 */

export const ALLOWLIST = [];

const NAMED_COLOURS = ["white", "black", "red", "green", "blue", "orange", "yellow", "purple", "gray", "grey", "pink"];
const OBSIDIAN_VARIABLE = /var\(\s*--(?:background|text|color|interactive|size|radius|font|shadow|layer)-[\w-]*/;
const RAW_COLOUR = new RegExp(
  String.raw`#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(|(?<![\w-])(?:${NAMED_COLOURS.join("|")})(?![\w-])`,
);
const PX = /(?<![\w-])-?\d*\.?\d+px\b/;

/** Line number of `index` in `text`. */
function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/** Replace comments with spaces, keeping offsets and line numbers. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

/**
 * Every declaration in `css` with its property, value, and line. Rules nest
 * inside at-rules; a block that holds other blocks is walked, not read.
 */
export function declarations(css) {
  const text = stripComments(css);
  const found = [];
  const stack = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      stack.push(text.slice(start, index).trim());
      start = index + 1;
    } else if (char === "}" || char === ";") {
      const chunk = text.slice(start, index);
      const colon = chunk.indexOf(":");
      const prelude = stack.at(-1) ?? "";
      if (colon > 0 && !prelude.startsWith("@")) {
        const property = chunk.slice(0, colon).trim();
        const value = chunk.slice(colon + 1).trim();
        const offset = start + chunk.search(/\S/);
        if (/^-?-?[\w-]+$/.test(property)) found.push({ property, value, line: lineOf(text, offset), selector: prelude });
      }
      if (char === "}") stack.pop();
      start = index + 1;
    }
  }
  return found;
}

/** Token-rule violations in `css`, one string per problem. */
export function checkCssTokens(css, file = "styles.css") {
  const errors = [];
  for (const { property, value, line, selector } of declarations(css)) {
    if (property.startsWith("--ac-")) continue;
    const where = `${file}:${line} ${selector.replace(/\s+/g, " ")} { ${property}: ${value} }`;
    if (ALLOWLIST.includes(where)) continue;
    if (RAW_COLOUR.test(value)) errors.push(`${where}: raw colour; use an --ac-* token`);
    if (PX.test(value)) errors.push(`${where}: px length; use an --ac-* token`);
    if (OBSIDIAN_VARIABLE.test(value)) errors.push(`${where}: Obsidian variable; map it in the --ac-* layer`);
  }
  return errors;
}

async function main() {
  const file = process.argv[2] ?? "styles.css";
  const css = readFileSync(path.resolve(process.cwd(), file), "utf8");
  const errors = checkCssTokens(css, file);
  const total = declarations(css).length;
  if (errors.length > 0) {
    console.error(`css tokens: FAIL (${errors.length} error(s) in ${total} declarations)`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`css tokens: PASS (${total} declarations, allowlist ${ALLOWLIST.length})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
