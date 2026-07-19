// Shared gitignore-style glob compilation used by vault ignore lists
// (src/vault/ignore.ts) and the external-workspace tool
// (src/tools/external-workspace.ts). Keeping one implementation avoids the two
// call sites drifting apart on subtle matching semantics.

const REGEX_SPECIAL = /[.+^${}()|[\]\\]/g;

/**
 * Translate a single glob body into a regex source fragment.
 *
 * Supported syntax:
 * - `*`  matches any run of characters except `/`
 * - `**` matches across directory separators
 * - `**\/` spans zero or more directories
 * - `?`  matches a single character except `/`
 */
export function globToRegExpSource(glob: string): string {
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

/**
 * Compile a gitignore-style pattern into an anchored regex source, or `null`
 * for blank/comment lines that should be skipped.
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
  return `${prefix}${globToRegExpSource(body)}${suffix}`;
}
