import type { App } from "obsidian";
import type { ObsidianSessionManager } from "../session/session-manager";
import { applyUndo, type UndoEntry } from "./undo";

export interface FileCheckpoint {
  version: 1;
  id: string;
  toolCallId: string;
  toolName: string;
  createdAt: string;
  entries: readonly UndoEntry[];
}

export interface FileCheckpointCreateInput {
  toolCallId: string;
  toolName: string;
  entries: readonly UndoEntry[];
  now?: () => number;
}

export interface FileCheckpointRestoreFailure {
  entry: UndoEntry;
  error: string;
}

export interface FileCheckpointRestoreResult {
  ok: boolean;
  restored: readonly string[];
  failed: readonly FileCheckpointRestoreFailure[];
  summary: string;
}

export interface AgentFileCheckpointRecorderOptions {
  sessionManager: Pick<ObsidianSessionManager, "appendFileCheckpoint" | "hasActiveSession">;
}

export class AgentFileCheckpointRecorder {
  constructor(private readonly options: AgentFileCheckpointRecorderOptions) {}

  async record(checkpoint: FileCheckpoint): Promise<void> {
    if (!this.options.sessionManager.hasActiveSession()) return;
    await this.options.sessionManager.appendFileCheckpoint(checkpoint);
  }
}

export function createFileCheckpoint(input: FileCheckpointCreateInput): FileCheckpoint {
  if (input.entries.length === 0) throw new Error("A file checkpoint requires at least one entry.");
  return {
    version: 1,
    id: `checkpoint-${input.toolCallId}`,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    createdAt: new Date(input.now?.() ?? Date.now()).toISOString(),
    entries: input.entries,
  };
}

export function createFileCheckpointFromUndo(
  input: Omit<FileCheckpointCreateInput, "entries"> & { undo: UndoEntry },
): FileCheckpoint {
  return createFileCheckpoint({ ...input, entries: [input.undo] });
}

export async function restoreFileCheckpoint(app: App, checkpoint: FileCheckpoint): Promise<FileCheckpointRestoreResult> {
  const restored: string[] = [];
  const failed: FileCheckpointRestoreFailure[] = [];

  for (const entry of [...checkpoint.entries].reverse()) {
    try {
      restored.push(await applyUndo(app, entry));
    } catch (error) {
      failed.push({ entry, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const ok = failed.length === 0;
  return {
    ok,
    restored,
    failed,
    summary: restoreSummary(restored, failed),
  };
}

export function fileCheckpointTouchedPaths(checkpoint: FileCheckpoint): readonly string[] {
  return [...new Set(checkpoint.entries.flatMap(touchedPathsForUndo))];
}

function touchedPathsForUndo(entry: UndoEntry): readonly string[] {
  if (entry.kind === "rename") return [entry.from, entry.to];
  return [entry.path];
}

function restoreSummary(restored: readonly string[], failed: readonly FileCheckpointRestoreFailure[]): string {
  if (failed.length === 0) {
    if (restored.length === 1) return restored[0] ?? "Checkpoint restored.";
    return `Restored ${restored.length} checkpoint changes.`;
  }
  const first = failed[0];
  const detail = first ? first.error : "unknown failure";
  if (restored.length === 0) return `Could not undo: ${detail}`;
  return `Partially restored ${restored.length} checkpoint changes; ${failed.length} failed: ${detail}`;
}
