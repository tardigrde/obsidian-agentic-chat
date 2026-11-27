import type { UndoEntry } from "./undo";

/**
 * The checkpoint shape the session writer persists. Kept out of
 * `file-checkpoints.ts` so the session layer does not import the agent
 * recorder that also reads the session manager (#438).
 */
export interface FileCheckpoint {
  version: 1;
  id: string;
  toolCallId: string;
  toolName: string;
  createdAt: string;
  entries: readonly UndoEntry[];
}
