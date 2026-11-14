// Adapted from lhr0909/pi-obsidian (Simon Liang), MIT License.
// https://github.com/lhr0909/pi-obsidian
import { PLUGIN_ID } from "../constants";

export interface VaultPathOptions {
  /** Permit paths inside this plugin's own folder (used for session storage). */
  allowPluginInternals?: boolean;
}

/**
 * Normalize a model-supplied path to a safe, vault-relative path.
 * Rejects absolute paths and `..` escapes so a tool can never reach outside
 * the vault, and (by default) blocks the plugin's own internals.
 */
export function normalizeVaultPath(input: string, options: VaultPathOptions = {}): string {
  const withoutAt = stripLeadingAt(input.trim());
  const withForwardSlashes = withoutAt.replaceAll("\\", "/");

  if (withForwardSlashes.startsWith("/")) {
    throw new Error("Path must be vault-relative, not absolute.");
  }

  const normalized = collapsePathSegments(withForwardSlashes);
  if (!options.allowPluginInternals && isPluginInternalPath(normalized)) {
    throw new Error(`Path points inside the ${PLUGIN_ID} plugin internals.`);
  }
  return normalized;
}

export function normalizeFolderPath(input: string, options: VaultPathOptions = {}): string {
  const normalized = normalizeVaultPath(input || "", options);
  return normalized === "." ? "" : normalized;
}

/**
 * Normalize a lookup key for retrieval matching: case-insensitive, slash
 * separated, and without a leading slash. It deliberately keeps trailing and
 * `.`/`..` segments because note links may contain them. Do not use it for
 * file access; use {@link normalizeVaultPath} for that.
 */
export function normalizeLookupPath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/").toLowerCase();
}

export function getParentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function stripLeadingAt(input: string): string {
  if (input === "@") return "";
  return input.startsWith("@/") ? input.slice(2) : input;
}

function collapsePathSegments(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      throw new Error("Path must not contain '..' segments.");
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function isPluginInternalPath(path: string): boolean {
  // Block the plugin's own internals regardless of the vault's configured configDir
  // (default `.obsidian` or a custom dir). Match only exact segment `plugins/<id>`
  // to avoid false positives on sibling dirs like `plugins/agentic-chat-extra`.
  if (path === `plugins/${PLUGIN_ID}` || path.startsWith(`plugins/${PLUGIN_ID}/`)) return true;
  const needle = `/plugins/${PLUGIN_ID}`;
  if (path === needle.slice(1)) return true;
  if (path.endsWith(needle)) return true;
  if (path.includes(`${needle}/`)) return true;
  return false;
}
