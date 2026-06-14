// Ignore lists: vault-relative globs the agent may never read or even see.
// Enforced at the tool layer (see src/tools/vault-tools.ts) so the model cannot
// route around them. Excluded paths are made invisible, not merely denied.

export type IgnoreMatcher = (path: string) => boolean;

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

/** Split a newline-delimited setting into patterns, dropping blanks and `#` comments. */
export function parseIgnorePatterns(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/**
 * Build a matcher for vault-relative paths from gitignore-style patterns.
 * Matching is case-insensitive (a security feature should over-block rather
 * than let `Secret.md` slip past `secret.md`).
 *
 * Supported syntax:
 * - `*`  matches any run of characters except `/`
 * - `**` matches across directory separators
 * - `?`  matches a single character except `/`
 * - a leading `/` anchors the pattern to the vault root
 * - a pattern containing a `/` is anchored to the vault root; otherwise it
 *   matches at any depth (by basename), like gitignore
 * - any match also covers the path's subtree, so a folder pattern hides the
 *   files inside it; a trailing `/` is therefore optional/documentary
 */
export function createIgnoreMatcher(patterns: string[]): IgnoreMatcher {
  const sources = patterns
    .map(compilePatternSource)
    .filter((source): source is string => source !== null);
  if (sources.length === 0) return () => false;
  // One combined regex = a single pass per path, instead of one test per pattern.
  const combined = new RegExp(sources.map((source) => `(?:${source})`).join("|"), "i");
  return (path) => combined.test(path.replace(/^\/+/, ""));
}

function compilePatternSource(pattern: string): string | null {
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
  return `${prefix}${globToRegExpSource(body)}${suffix}`;
}

function globToRegExpSource(glob: string): string {
  let out = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        // `**/` spans zero or more directories (so `**/x` also matches `x` at root);
        // a bare `**` spans any characters including separators.
        if (glob[index + 2] === "/") {
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
      out += char.replace(REGEX_SPECIAL, "\\$&");
    }
  }
  return out;
}
