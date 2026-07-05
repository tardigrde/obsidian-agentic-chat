import type { ToolArtifactReadResult, ToolArtifactStoreLike } from "../artifacts/tool-artifact-store";

export type ExistingSourceArtifactMatchReason = "dedup-key" | "source-text-hash";

export interface ExistingSourceArtifactMatch {
  artifact: ToolArtifactReadResult;
  reason: ExistingSourceArtifactMatchReason;
}

export async function findExistingSourceArtifact(
  store: ToolArtifactStoreLike,
  options: {
    dedupKey: string;
    textHash: string;
    legacyDedupKeys?: readonly string[];
    legacyTextHashes?: readonly string[];
  },
): Promise<ExistingSourceArtifactMatch | null> {
  for (const dedupKey of uniqueNonEmpty([options.dedupKey, ...(options.legacyDedupKeys ?? [])])) {
    const exact = await store.findArtifactByDedupKey?.(dedupKey);
    if (exact) return { artifact: exact, reason: "dedup-key" };
  }

  for (const textHash of uniqueNonEmpty([options.textHash, ...(options.legacyTextHashes ?? [])])) {
    const textDuplicate = await store.findArtifactBySourceTextHash?.(textHash);
    if (textDuplicate) return { artifact: textDuplicate, reason: "source-text-hash" };
  }

  return null;
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}
