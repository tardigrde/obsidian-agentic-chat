import type { App, TAbstractFile, TFile } from "obsidian";

/**
 * Path lookup for model-supplied vault paths.
 *
 * Obsidian indexes paths byte-exact, but the same name can reach us in a
 * different Unicode normalization (NFC on disk, NFD from a macOS clipboard or a
 * model that decomposed an accent). NFC comparison heals exactly that drift,
 * and only when it is unambiguous. A different spelling is never changed for
 * the model — it gets a suggestion instead, so a typo cannot silently rename or
 * overwrite a note.
 */

/** Minimum similarity for a suggestion; below this the paths are unrelated. */
const SUGGESTION_THRESHOLD = 0.75;
/** The best candidate must beat the runner-up by this much to count as clear. */
const SUGGESTION_MARGIN = 0.05;

/** Exact lookup first, then the single file whose NFC path matches. */
export function findVaultFile(app: App, path: string): TFile | undefined {
  const exact = app.vault.getFileByPath(path);
  if (exact) return exact;
  return uniqueNormalizedMatch(app.vault.getFiles(), path);
}

/** Exact lookup first, then the single loaded file or folder whose NFC path matches. */
export function findVaultEntry(app: App, path: string): TAbstractFile | undefined {
  const exact = app.vault.getAbstractFileByPath(path);
  if (exact) return exact;
  return uniqueNormalizedMatch(app.vault.getAllLoadedFiles(), path);
}

/**
 * The one clear near-miss for `path`, or undefined. Ignored entries are never
 * suggested: an ignore rule makes a path invisible, so naming it would leak it
 * back to the model.
 */
export function pathSuggestion(
  app: App,
  path: string,
  isIgnored: (path: string) => boolean,
): string | undefined {
  const target = foldForComparison(path);
  if (!target) return undefined;
  const scored: Array<{ path: string; score: number }> = [];
  for (const entry of app.vault.getAllLoadedFiles()) {
    if (!entry.path || isIgnored(entry.path)) continue;
    const candidate = foldForComparison(entry.path);
    // Equal after folding is the automatic NFC/NFD case. It either resolved
    // already or it is ambiguous; never guess between the spellings.
    if (!candidate || candidate === target) continue;
    scored.push({ path: entry.path, score: bigramDice(target, candidate) });
  }
  scored.sort((left, right) => right.score - left.score);
  const best = scored[0];
  if (!best || best.score < SUGGESTION_THRESHOLD) return undefined;
  if (best.score - (scored[1]?.score ?? 0) < SUGGESTION_MARGIN) return undefined;
  return best.path;
}

function uniqueNormalizedMatch<T extends TAbstractFile>(entries: T[], path: string): T | undefined {
  const key = path.normalize("NFC");
  const matches = entries.filter((entry) => entry.path.normalize("NFC") === key);
  return matches.length === 1 ? matches[0] : undefined;
}

/** NFC, casefold, and drop combining marks so "ú" and "u" compare equal. */
function foldForComparison(path: string): string {
  return path
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .normalize("NFC");
}

/** Sorensen-Dice over character bigrams: cheap, and forgiving of one bad word. */
function bigramDice(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length < 2 || right.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let index = 0; index < left.length - 1; index += 1) {
    const bigram = left.slice(index, index + 2);
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }
  let shared = 0;
  for (let index = 0; index < right.length - 1; index += 1) {
    const bigram = right.slice(index, index + 2);
    const count = counts.get(bigram) ?? 0;
    if (count > 0) {
      counts.set(bigram, count - 1);
      shared += 1;
    }
  }
  return (2 * shared) / (left.length - 1 + right.length - 1);
}
