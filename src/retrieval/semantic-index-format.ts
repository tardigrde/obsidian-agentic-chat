import type { DataAdapter } from "obsidian";
import { ensureAdapterParentFolder, renameOver, writeFileAtomically } from "../vault/storage";
import type { EmbeddingIndexSnapshot } from "./embeddings";
import {
  createScopedIndexState,
  type EmbeddingIndexCostEstimate,
  type RetrievalIndexScope,
  type RetrievalIndexingStatus,
  type ScopedRetrievalIndexState,
} from "./policy";

export interface SemanticIndexFile {
  version: 1;
  updatedAt: number;
  state: ScopedRetrievalIndexState;
  snapshot?: EmbeddingIndexSnapshot;
}

export const SEMANTIC_INDEX_VERSION = 1;

export async function readValidSemanticIndexFile(
  adapter: DataAdapter,
  path: string,
): Promise<SemanticIndexFile | null> {
  if (!(await adapter.exists(path))) return null;
  try {
    const parsed = JSON.parse(await adapter.read(path)) as SemanticIndexFile;
    if (parsed?.version !== SEMANTIC_INDEX_VERSION || !parsed.state?.status) return null;
    return parsed;
  } catch {
    return null;
  }
}

export type CurrentSemanticIndex =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "valid"; file: SemanticIndexFile };

/**
 * A read error is not the same as an absent file. The writer must know the
 * difference before it removes a target it cannot validate.
 */
export async function readCurrentSemanticIndex(
  adapter: DataAdapter,
  path: string,
): Promise<CurrentSemanticIndex> {
  if (!(await adapter.exists(path))) return { kind: "missing" };
  try {
    const parsed = JSON.parse(await adapter.read(path)) as SemanticIndexFile;
    if (parsed?.version !== SEMANTIC_INDEX_VERSION || !parsed.state?.status) {
      return { kind: "unreadable" };
    }
    return { kind: "valid", file: parsed };
  } catch {
    return { kind: "unreadable" };
  }
}

export async function hasCompleteSemanticIndexBackup(
  adapter: DataAdapter,
  path: string,
): Promise<boolean> {
  const backup = await readValidSemanticIndexFile(adapter, semanticIndexBackupPath(path));
  return backup?.state.status.state === "complete";
}

export async function writeSemanticIndexFile(
  adapter: DataAdapter,
  path: string,
  file: SemanticIndexFile,
): Promise<void> {
  await ensureAdapterParentFolder(adapter, path);
  const serialized = JSON.stringify(file, null, 2);
  const tempPath = semanticIndexTempPath(path);

  // Never truncate the live index in place. The new bytes land in a temp file
  // first; only a complete rename makes them the target.
  await adapter.write(tempPath, serialized);

  // Preserve the current complete index before any replacement, including the
  // first `running` write of a rebuild. A running or failed target is not a
  // complete index, so it never overwrites the backup.
  const current = await readCurrentSemanticIndex(adapter, path);
  if (current.kind === "valid" && current.file.state.status.state === "complete") {
    await writeFileAtomically(adapter, semanticIndexBackupPath(path), JSON.stringify(current.file, null, 2), {
      tempPath: semanticIndexTempPath(semanticIndexBackupPath(path)),
    });
  } else if (current.kind === "unreadable" && !(await hasCompleteSemanticIndexBackup(adapter, path))) {
    throw new Error(
      "Refusing to replace an unreadable semantic index without a complete backup.",
    );
  }

  // A target that is complete, or unreadable and protected by a backup, may be
  // removed only when a complete backup is still present.
  const requireBackup =
    current.kind === "unreadable" ||
    (current.kind === "valid" && current.file.state.status.state === "complete");
  await renameOver(adapter, tempPath, path, async () => {
    if (requireBackup && !(await hasCompleteSemanticIndexBackup(adapter, path))) {
      throw new Error("Refusing to replace the semantic index: its complete backup is missing.");
    }
    await adapter.remove(path);
    await adapter.rename(tempPath, path);
  });
}

export function semanticIndexTempPath(path: string): string {
  return `${path}.tmp`;
}

export function semanticIndexBackupPath(path: string): string {
  return `${path}.bak`;
}

export function semanticIndexFile(input: {
  scope: RetrievalIndexScope;
  status: RetrievalIndexingStatus;
  estimate?: EmbeddingIndexCostEstimate;
  indexedDocumentIds: readonly string[];
  snapshot?: EmbeddingIndexSnapshot;
  updatedAt: number;
}): SemanticIndexFile {
  return {
    version: SEMANTIC_INDEX_VERSION,
    updatedAt: input.updatedAt,
    state: createScopedIndexState({
      scope: input.scope,
      status: input.status,
      estimate: input.estimate,
      indexedDocumentIds: input.indexedDocumentIds,
    }),
    snapshot: input.snapshot,
  };
}

export function semanticIndexPath(pluginDir: string): string {
  return `${pluginDir.replace(/\/+$/, "")}/semantic-index/index.json`;
}
