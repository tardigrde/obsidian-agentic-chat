// Shared gitignore-style glob compilation used by the vault ignore list
// (src/vault/ignore.ts) and the MCP tool filter (src/mcp/tool-filter.ts).
// Keeping one implementation avoids call sites drifting apart on subtle
// matching semantics.

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;
// Repeated "**/" segments compile to stacked optional groups `(?:.*/)?` that
// make matching combinatorial (exponential backtracking on non-matches).
// `*` -> `[^/]*` is linear; only the optional "**/" groups blow up, so cap how
// many a single pattern may carry. Deep traversal is still possible with a
// single "**" segment (which matches across separators).
export const MAX_DOUBLE_STAR_SEGMENTS = 3;

/**
 * Translate a single glob body into a regex source fragment.
 *
 * Supported syntax:
 * - `*`  matches any run of characters except `/`
 * - `**` matches across directory separators (a repeat-star
 *   followed by `/` spans zero or more directories)
 * - `?`  matches a single character except `/`
 *
 * A glob whose double-star segments exceed {@link MAX_DOUBLE_STAR_SEGMENTS} is
 * rejected (returns `null`) to keep matching linear-time.
 */
export function globToRegExpSource(glob: string): string | null {
  let out = "";
  let doubleStarSegments = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        // `**/` spans zero or more directories (so `**/x` also matches `x` at root);
        // a bare `**` spans any characters including separators.
        if (glob[index + 2] === "/") {
          doubleStarSegments += 1;
          if (doubleStarSegments > MAX_DOUBLE_STAR_SEGMENTS) return null;
          out += "(?:.*/)?";
          index += 2;
        } else {
          out += ".*";
          index += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(REGEX_SPECIAL, String.raw`\$&`);
    }
  }
  return out;
}

/**
 * Compile a gitignore-style pattern into an anchored regex source, or `null`
 * for blank/comment lines and patterns that would be unsafe to compile
 * (excessive double-star segments, see {@link globToRegExpSource}).
 *
 * - a leading `/` anchors the pattern to the root
 * - a pattern containing a `/` is anchored to the root; otherwise it matches at
 *   any depth (by basename), like gitignore
 * - any match also covers the path's subtree, so a folder pattern hides the
 *   files inside it; a trailing `/` is therefore optional/documentary
 */
export function compileGitignorePatternSource(pattern: string): string | null {
  let body = pattern.trim();
  if (!body || body.startsWith("#")) return null;

  // A trailing slash is documentary: every match already covers the folder's
  // subtree (see suffix below), so `Private` and `Private/` behave identically.
  if (body.endsWith("/")) body = body.slice(0, -1);

  let anchored = false;
  if (body.startsWith("/")) {
    anchored = true;
    body = body.slice(1);
  }
  if (!body) return null;

  const rootScoped = anchored || body.includes("/");
  const prefix = rootScoped ? "^" : "(?:^|.*/)";
  // Always extend a match to the whole subtree so a folder pattern hides the
  // files inside it (matching gitignore). Without this, `Private` would match
  // the folder node but leak `Private/Secret.md` — a silent security bypass.
  const suffix = "(?:/.*)?$";
  const source = globToRegExpSource(body);
  if (source === null) return null;
  return `${prefix}${source}${suffix}`;
}
