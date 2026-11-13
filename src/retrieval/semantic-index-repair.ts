import type { DataAdapter } from "obsidian";
import { SEMANTIC_INDEX_VERSION, writeSemanticIndexFile, type SemanticIndexFile } from "./semantic-index-format";

export interface SemanticIndexRepairLease {
  release(): void | Promise<void>;
}

export type AcquireSemanticIndexRepairLease = (path: string) => Promise<SemanticIndexRepairLease | null>;

/**
 * A `running` status on disk can only mean the previous writer stopped before
 * it could record a terminal state. Repair it on read so the status never lies.
 */
export async function repairInterruptedIndex(
  adapter: DataAdapter,
  path: string,
  file: SemanticIndexFile,
  acquireLease: AcquireSemanticIndexRepairLease,
): Promise<SemanticIndexFile> {
  if (file.state.status.state !== "running") return file;
  // Hold the same lease a writer uses. Without it, a writer can acquire the
  // index between the check and the write and lose its file to our repair.
  let lease: SemanticIndexRepairLease | null;
  try {
    lease = await acquireLease(path);
  } catch {
    // A status read must still work when the shared lease store is unavailable.
    return file;
  }
  if (!lease) return file;
  try {
    // Re-read before writing: a status read can race a completed run, and the
    // newer snapshot must win over this stale repair.
    let latest = file;
    try {
      const candidate = JSON.parse(await adapter.read(path)) as SemanticIndexFile;
      if (candidate?.version === SEMANTIC_INDEX_VERSION && candidate.state?.status) latest = candidate;
    } catch {
      return file;
    }
    if (latest.updatedAt !== file.updatedAt) return latest;
    if (latest.state.status.state !== "running") return latest;

    const status = latest.state.status;
    const repaired: SemanticIndexFile = {
      ...latest,
      state: {
        ...latest.state,
        status: {
          state: "failed",
          scope: status.scope,
          processedDocuments: status.processedDocuments,
          totalDocuments: status.totalDocuments,
          error: "Semantic indexing was interrupted before it finished. Run it again to complete the index.",
        },
      },
    };
    try {
      await writeSemanticIndexFile(adapter, path, repaired);
    } catch {
      // A read-only adapter still gets the repaired view; persistence is best effort.
    }
    return repaired;
  } finally {
    await lease.release();
  }
}
