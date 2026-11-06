import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createReplayStreamController,
  type ReplayStreamCall,
  type ReplayTurn,
} from "./replay-stream";

export type E2EStreamTurn = ReplayTurn;

export interface E2EStreamTarget {
  __AGENTIC_CHAT_E2E_TURNS__?: E2EStreamTurn[];
  __AGENTIC_CHAT_E2E_CALLS__?: number;
  __AGENTIC_CHAT_E2E_CALL_LOG__?: ReplayStreamCall[];
  /** Set true to finish a scripted `hold` turn. */
  __AGENTIC_CHAT_E2E_RELEASE__?: boolean;
}

export interface E2EStreamOptions {
  enabled: boolean;
  target?: E2EStreamTarget;
}

declare global {
  interface Window extends E2EStreamTarget {
    /** Internal WDIO-only hook for scripted model turns; inert unless a spec sets it before opening chat. */
    __AGENTIC_CHAT_E2E_TURNS__?: E2EStreamTurn[];
    __AGENTIC_CHAT_E2E_CALLS__?: number;
    __AGENTIC_CHAT_E2E_CALL_LOG__?: ReplayStreamCall[];
  }
}

function getWindowE2ETarget(): E2EStreamTarget | undefined {
  return typeof window === "undefined" ? undefined : window;
}

export function createWindowE2EStreamFn(options: E2EStreamOptions): StreamFn | undefined {
  if (!options.enabled) return undefined;

  const target = options.target ?? getWindowE2ETarget();
  if (!target || !Array.isArray(target.__AGENTIC_CHAT_E2E_TURNS__)) return undefined;

  const initialTurnIndex = Math.max(0, target.__AGENTIC_CHAT_E2E_CALLS__ ?? 0);
  target.__AGENTIC_CHAT_E2E_CALLS__ = initialTurnIndex;
  target.__AGENTIC_CHAT_E2E_CALL_LOG__ ??= [];
  const controller = createReplayStreamController(target.__AGENTIC_CHAT_E2E_TURNS__, {
    missingTurn: "error",
    initialTurnIndex,
    onCall: (call) => {
      target.__AGENTIC_CHAT_E2E_CALLS__ = call.index + 1;
      target.__AGENTIC_CHAT_E2E_CALL_LOG__?.push(call);
    },
    waitForRelease: async () => {
      while (!target.__AGENTIC_CHAT_E2E_RELEASE__) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
      }
    },
  });
  return controller.streamFn;
}
