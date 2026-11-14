import type { CompactionTarget } from "../../src/agent/compaction-runtime";
import type { ObsidianSessionManager } from "../../src/session/session-manager";

/**
 * A compaction target that persists straight into a session manager, for tests
 * that exercise the compaction runtime without a live agent or a session queue.
 */
export function managerCompactionTarget(manager: ObsidianSessionManager): CompactionTarget {
  return {
    getBinding: () => ({
      expectedPath: manager.getActiveSessionPath(),
      expectedGeneration: manager.getActiveSessionGeneration(),
    }),
    commitCompaction: (messages, binding) => manager.rewriteMessages(messages, binding),
  };
}
