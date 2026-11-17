import { readdirSync } from "node:fs";
import path from "node:path";

/**
 * A small glob matcher for repo-relative paths with forward slashes.
 * Supports `**` (any depth), `*` and `?` (within one segment), and `{a,b}`.
 * Kept in-repo so the T0 checkers need no dependency.
 */
/** Code-unit order, the same as a bare `sort()`, but explicit. */
export function compareStrings(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

export function globToRegExp(glob) {
  let out = "";
  let inBraces = 0;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        const slash = glob[index + 2] === "/";
        out += slash ? "(?:.*/)?" : ".*";
        index += slash ? 2 : 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      inBraces += 1;
      out += "(?:";
    } else if (char === "}" && inBraces > 0) {
      inBraces -= 1;
      out += ")";
    } else if (char === "," && inBraces > 0) {
      out += "|";
    } else {
      out += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(file, globs) {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

/** Every file under `dir` (repo-relative, forward slashes), skipping heavy dirs. */
export function listFiles(root, dir, skip = new Set(["node_modules", ".git", "logs", ".obsidian-cache", "coverage"])) {
  const out = [];
  const walk = (relative) => {
    let entries;
    try {
      entries = readdirSync(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  walk(dir);
  return out.sort(compareStrings);
}
