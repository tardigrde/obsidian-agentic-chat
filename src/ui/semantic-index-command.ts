import type { RetrievalIndexScope } from "../retrieval/policy";
import { normalizeFolderPath } from "../vault/path";

export interface SemanticIndexScopeContext {
  activeNotePath?: string | null;
}

export type ParsedSemanticIndexScope =
  | { scope: RetrievalIndexScope; confirmVault: boolean }
  | { error: string };

export function parseSemanticIndexScopeCommand(
  tokens: readonly string[],
  context: SemanticIndexScopeContext = {},
): ParsedSemanticIndexScope {
  const confirmVault = tokens.includes("--confirm-vault");
  const args = tokens.filter((token) => token !== "--confirm-vault");
  const [kind = "", ...rest] = args;
  const lower = kind.toLowerCase();

  if (!lower) return defaultSemanticIndexScope(context, confirmVault);

  if (lower === "folder") {
    const folder = rest.join(" ").trim();
    if (!folder) return { error: "Usage: /semantic-index start folder <path>" };
    return folderSemanticIndexScope(folder, confirmVault);
  }

  if (lower === "tag") {
    const tag = rest.join(" ").trim().replace(/^#/, "");
    if (!tag) return { error: "Usage: /semantic-index start tag <tag>" };
    return { scope: { kind: "tag", label: `#${tag}`, tags: [tag] }, confirmVault };
  }

  if (lower === "vault") {
    return { scope: { kind: "vault", label: "Whole vault" }, confirmVault };
  }

  return { error: `Unknown semantic index scope "${kind}". Use folder, tag, or vault.` };
}

function defaultSemanticIndexScope(
  context: SemanticIndexScopeContext,
  confirmVault: boolean,
): ParsedSemanticIndexScope {
  const activeFolder = activeNoteFolder(context.activeNotePath);
  if (activeFolder !== null) {
    // A root-level active note resolves to folder "" — which matches every file
    // in the vault. That is a vault-wide index without the --confirm-vault
    // gate, so refuse and make the scope explicit instead.
    if (activeFolder === "") {
      return {
        error:
          "The active note is in the vault root, so the default scope would cover the whole vault. " +
          "Choose a scope: folder <path>, tag <tag>, or vault --confirm-vault.",
      };
    }
    return { scope: { kind: "folder", label: activeFolder, paths: [activeFolder] }, confirmVault };
  }

  return { error: "Choose a scope: folder <path>, tag <tag>, or vault --confirm-vault." };
}

function folderSemanticIndexScope(folder: string, confirmVault: boolean): ParsedSemanticIndexScope {
  let normalized: string;
  try {
    normalized = normalizeFolderPath(folder === "/" ? "" : folder);
  } catch {
    return { error: `Invalid folder path "${folder}".` };
  }
  // "/" or "." normalize to the vault root — i.e. everything. Route that intent
  // through the explicit vault confirmation instead of a silent full-vault index.
  if (!normalized) {
    return confirmVault
      ? { scope: { kind: "vault", label: "Whole vault" }, confirmVault }
      : { error: `"${folder}" covers the whole vault. Re-run with --confirm-vault to index everything.` };
  }
  return { scope: { kind: "folder", label: normalized, paths: [normalized] }, confirmVault };
}

function activeNoteFolder(path: string | null | undefined): string | null {
  if (!path) return null;
  return path.split("/").slice(0, -1).join("/");
}
