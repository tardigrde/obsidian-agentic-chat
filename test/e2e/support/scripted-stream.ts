import { browser } from "@wdio/globals";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { E2EStreamTurn } from "../../../src/agent/e2e-stream";

/**
 * Shared browser-side scripted model turns for e2e specs. The turn shape comes
 * from the production contract, so a field rename breaks the helper (and every
 * spec that imports it) at typecheck time instead of at runtime.
 */
export type ScriptedTurn = E2EStreamTurn;

type TurnOptions = Omit<Partial<ScriptedTurn>, "label" | "content">;

export function textTurn(label: string, text: string, options: TurnOptions = {}): ScriptedTurn {
  return {
    ...options,
    label,
    stopReason: "stop",
    content: [{ type: "text", text }],
  };
}

export function toolTurn(
  label: string,
  id: string,
  name: string,
  args: Record<string, unknown>,
): ScriptedTurn {
  return {
    label,
    stopReason: "toolUse",
    content: [{ type: "toolCall", id, name, arguments: args as unknown as JsonObject }],
  };
}

export function readTurn(label: string, path: string, options: TurnOptions = {}): ScriptedTurn {
  return {
    ...options,
    label,
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: `e2e-${label}`, name: "read", arguments: { path } }],
  };
}

export function toolBatch(
  label: string,
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): ScriptedTurn {
  return {
    label,
    stopReason: "toolUse",
    content: calls.map((call) => ({
      type: "toolCall",
      id: call.id,
      name: call.name,
      arguments: call.args as unknown as JsonObject,
    })),
  };
}

export async function installScriptedTurns(turns: ScriptedTurn[]): Promise<void> {
  await browser.execute((scriptedTurns) => {
    const target = window as typeof window & {
      __AGENTIC_CHAT_E2E_TURNS__?: ScriptedTurn[];
      __AGENTIC_CHAT_E2E_CALLS__?: number;
      __AGENTIC_CHAT_E2E_CALL_LOG__?: unknown[];
      __AGENTIC_CHAT_E2E_RELEASE__?: boolean;
    };
    target.__AGENTIC_CHAT_E2E_TURNS__ = scriptedTurns;
    target.__AGENTIC_CHAT_E2E_CALLS__ = 0;
    target.__AGENTIC_CHAT_E2E_CALL_LOG__ = [];
    target.__AGENTIC_CHAT_E2E_RELEASE__ = false;
  }, turns);
}

export async function releaseScriptedTurns(release = true): Promise<void> {
  await browser.execute((value) => {
    const target = window as typeof window & { __AGENTIC_CHAT_E2E_RELEASE__?: boolean };
    target.__AGENTIC_CHAT_E2E_RELEASE__ = value;
  }, release);
}

export async function clearScriptedTurns(): Promise<void> {
  await browser.execute(() => {
    const target = window as typeof window & {
      __AGENTIC_CHAT_E2E_TURNS__?: unknown;
      __AGENTIC_CHAT_E2E_CALLS__?: number;
      __AGENTIC_CHAT_E2E_CALL_LOG__?: unknown[];
      __AGENTIC_CHAT_E2E_RELEASE__?: boolean;
    };
    delete target.__AGENTIC_CHAT_E2E_TURNS__;
    delete target.__AGENTIC_CHAT_E2E_CALLS__;
    delete target.__AGENTIC_CHAT_E2E_CALL_LOG__;
    delete target.__AGENTIC_CHAT_E2E_RELEASE__;
  });
}

export async function scriptedCallCount(): Promise<number> {
  return await browser.execute(() => {
    const target = window as typeof window & { __AGENTIC_CHAT_E2E_CALL_LOG__?: unknown[] };
    return target.__AGENTIC_CHAT_E2E_CALL_LOG__?.length ?? 0;
  });
}

export async function scriptedCallLabels(): Promise<string[]> {
  return await browser.execute(() => {
    const target = window as typeof window & {
      __AGENTIC_CHAT_E2E_CALL_LOG__?: Array<{ label?: string }>;
    };
    return target.__AGENTIC_CHAT_E2E_CALL_LOG__?.map((call) => call.label ?? "") ?? [];
  });
}

export async function scriptedCallToolNames(): Promise<string[][]> {
  return await browser.execute(() => {
    const target = window as typeof window & {
      __AGENTIC_CHAT_E2E_CALL_LOG__?: Array<{ toolNames?: string[] }>;
    };
    return target.__AGENTIC_CHAT_E2E_CALL_LOG__?.map((call) => call.toolNames ?? []) ?? [];
  });
}

export async function waitForScriptedCalls(count: number, timeout = 15_000): Promise<void> {
  await browser.waitUntil(async () => (await scriptedCallCount()) >= count, {
    timeout,
    timeoutMsg: `expected at least ${count} scripted turns, got ${await scriptedCallCount()}`,
  });
}
