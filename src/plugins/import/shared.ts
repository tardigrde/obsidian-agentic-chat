import type { FileTree } from "./archive";

const DECODER = new TextDecoder("utf-8");

/** Parse bytes as a JSON object; null for anything else (malformed or non-object). */
export function parseJson(bytes: Uint8Array | undefined): Record<string, unknown> | null {
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(DECODER.decode(bytes));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Best-effort skill name from a bare document's `name:` frontmatter. */
export function skillNameFromDoc(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null;
  const text = DECODER.decode(bytes.slice(0, 2000));
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const name = /^name:\s*(.+)$/m.exec(match[1]);
  return name?.[1] ? name[1].trim().replace(/['"]/g, "") : null;
}

/** Re-root a tree at `dir` (paths inside keep their relative form). */
export function reRootTree(tree: FileTree, dir: string): FileTree {
  const prefix = `${dir}/`;
  const subtree: FileTree = new Map();
  for (const [path, bytes] of tree) {
    if (path === dir) continue;
    if (path.startsWith(prefix)) subtree.set(path.slice(prefix.length), bytes);
  }
  return subtree;
}
