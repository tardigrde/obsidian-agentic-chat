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
 *   - a raw colour: `#hex`, a colour function, or any CSS named colour (any
 *     case); `transparent` and `currentColor` are not theme colours and pass
 *   - a `px` length
 *   - any `var()` that is not an `--ac-*` token (an Obsidian theme variable
 *     belongs in the token layer)
 *
 * Media and container query preludes may use `px` (CSS variables do not work
 * there). The allowlist is empty and stays empty: fix the rule, not the list.
 */

export const ALLOWLIST = [];

/** The 148 CSS named colours (CSS Color 4). */
const NAMED_COLOURS = `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue
darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory
khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen
lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive
olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue
slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke
yellow yellowgreen`.split(/\s+/);
/** Any `var()` whose name is not an `--ac-*` token. */
const NON_TOKEN_VARIABLE = /var\(\s*--(?!ac-)[\w-]+/;
const RAW_COLOUR = new RegExp(
  String.raw`#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\(|(?<![\w-])(?:${NAMED_COLOURS.join("|")})(?![\w-])`,
  "i",
);
// One number form per branch, so the engine never backtracks between them.
const PX = /(?<![\w-])-?(?:\d+(?:\.\d+)?|\.\d+)px\b/;

/** Line number of `index` in `text`. */
function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * Replace the inside of quoted strings with spaces, keeping offsets: a `;`,
 * `{`, or `}` in a string (an SVG data URI) must not split a declaration. The
 * raw text is still checked, from the original css, by offset.
 */
function maskStrings(css) {
  return css.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (quoted) => quoted[0] + " ".repeat(quoted.length - 2) + quoted.at(-1));
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
  const raw = stripComments(css);
  const text = maskStrings(raw);
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
      // At-rule blocks are checked too (@font-face, @property): their
      // declarations follow the same rule. @media and @container hold rules.
      if (colon > 0) {
        const property = chunk.slice(0, colon).trim();
        const value = raw.slice(start + colon + 1, index).trim();
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
    if (NON_TOKEN_VARIABLE.test(value)) errors.push(`${where}: Obsidian variable; map it in the --ac-* layer`);
  }
  return errors;
}

async function main() {
  const file = process.argv[2] ?? "styles.css";
  // Read only inside the checkout: the argument is a repo-relative path.
  const root = process.cwd();
  const target = path.resolve(root, file);
  if (path.relative(root, target).startsWith("..") || path.isAbsolute(path.relative(root, target))) {
    console.error(`css tokens: refusing ${file}: not inside ${root}`);
    process.exitCode = 2;
    return;
  }
  const css = readFileSync(target, "utf8");
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
