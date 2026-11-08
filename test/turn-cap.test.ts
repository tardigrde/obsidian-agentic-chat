import { describe, expect, it } from "vitest";
import type { AgentTurnContext } from "@earendil-works/pi-agent-core";
import { replayTextTurn, replayToolCallTurn, type ReplayTurn } from "../src/agent/replay-stream";
import { parseSessionEntries } from "../src/session/jsonl";
import { runAgentReplay } from "./helpers/agent-replay";

/**
 * Load the cap lazily. The witness runner reverts `src/agent/turn-cap.ts` and
 * then runs this file: a static import would turn the red run into a module
 * load error, which proves nothing. Each test asserts the module loaded, so the
 * red run fails on an assertion instead.
 */
let turnCapModulePromise: Promise<typeof import("../src/agent/turn-cap") | null> | null = null;

async function loadTurnCapModule(): Promise<typeof import("../src/agent/turn-cap") | null> {
  turnCapModulePromise ??= import("../src/agent/turn-cap").catch(() => null);
  return turnCapModulePromise;
}

async function requireTurnCapModule(): Promise<typeof import("../src/agent/turn-cap")> {
  const module = await loadTurnCapModule();
  expect(module).not.toBeNull();
  if (!module) throw new Error("src/agent/turn-cap.ts is missing.");
  return module;
}

function turn(stopReason: "toolUse" | "stop" | "error" | "aborted" = "toolUse"): AgentTurnContext {
  return {
    message: { role: "assistant", content: [], stopReason },
    toolResults: [],
  } as unknown as AgentTurnContext;
}

describe("AgentTurnCap", () => {
  it("uses the parent and child defaults from constants", async () => {
    const { AgentTurnCap, CHILD_TURN_CAP, PARENT_TURN_CAP } = await requireTurnCapModule();

    expect(PARENT_TURN_CAP).toBe(25);
    expect(CHILD_TURN_CAP).toBe(10);
    expect(new AgentTurnCap().maxTurns).toBe(25);
    expect(new AgentTurnCap({ maxTurns: CHILD_TURN_CAP }).maxTurns).toBe(10);
  });

  it("fires exactly at N, not before, and stays fired", async () => {
    const { AgentTurnCap, buildTurnCapNotice } = await requireTurnCapModule();
    const cap = new AgentTurnCap({ maxTurns: 3 });

    expect(cap.shouldStopAfterTurn(turn())).toBe(false);
    expect(cap.shouldStopAfterTurn(turn())).toBe(false);
    expect(cap.noticeText).toBeNull();

    expect(cap.shouldStopAfterTurn(turn())).toBe(true);
    expect(cap.noticeText).toBe(buildTurnCapNotice(3));
    expect(cap.shouldStopAfterTurn(turn())).toBe(true);
  });

  it("reset() clears the count and notice so the next prompt gets a full budget", async () => {
    const { AgentTurnCap } = await requireTurnCapModule();
    const cap = new AgentTurnCap({ maxTurns: 2 });

    expect(cap.shouldStopAfterTurn(turn())).toBe(false);
    expect(cap.shouldStopAfterTurn(turn())).toBe(true);
    expect(cap.noticeText).not.toBeNull();

    cap.reset();

    expect(cap.noticeText).toBeNull();
    expect(cap.shouldStopAfterTurn(turn())).toBe(false);
    expect(cap.shouldStopAfterTurn(turn())).toBe(true);
  });

  it("counts tool-free assistant turns", async () => {
    const { AgentTurnCap } = await requireTurnCapModule();
    const cap = new AgentTurnCap({ maxTurns: 2 });

    expect(cap.shouldStopAfterTurn(turn("stop"))).toBe(false);
    expect(cap.shouldStopAfterTurn(turn("stop"))).toBe(true);
    expect(cap.noticeText).toMatch(/Turn cap/);
  });

  it("never throws on malformed turns", async () => {
    const { AgentTurnCap } = await requireTurnCapModule();
    const malformed = [
      undefined,
      null,
      {},
      { message: null },
      { message: { stopReason: undefined } },
      { message: { stopReason: "toolUse" }, toolResults: null },
    ] as unknown as AgentTurnContext[];

    for (const value of malformed) {
      const cap = new AgentTurnCap({ maxTurns: 2 });
      expect(() => cap.shouldStopAfterTurn(value)).not.toThrow();
    }
  });
});

describe("AgentService turn cap", () => {
  it("stops a prompt at the parent cap without another model call", async () => {
    // Fall back to the default when the witness runner has reverted the cap
    // module. The test then runs the full scripted prompt and fails on the
    // call-count assertion because the parent has no cap at all.
    const PARENT_TURN_CAP = (await loadTurnCapModule())?.PARENT_TURN_CAP ?? 25;
    const turns: ReplayTurn[] = [];
    for (let index = 0; index < PARENT_TURN_CAP; index += 1) {
      turns.push(
        replayToolCallTurn(
          `cap-${index}`,
          "write",
          { path: "cap.md", content: `turn-${index}` },
          { label: `tool-${index}` },
        ),
      );
    }
    // If the cap fails, the agent consumes this turn and the length assertion
    // below fails. The label makes the failure easy to read.
    turns.push(replayTextTurn("must not be requested", { label: "beyond-cap" }));

    const result = await runAgentReplay({
      prompt: "keep working",
      // A per-tool write deny keeps the scripted tool turns cheap, and their
      // per-turn arguments differ enough not to trip the loop guard.
      settings: { mode: "safe", approval: { mutating: "allow", perTool: { write: "deny" } } },
      turns,
    });

    expect(result.calls).toHaveLength(PARENT_TURN_CAP);
    expect(result.calls.map((call) => call.label)).not.toContain("beyond-cap");

    const assistants = result.messages.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(PARENT_TURN_CAP + 1);
    expect(JSON.stringify(assistants.at(-1)?.content)).toMatch(
      new RegExp(`Turn cap: stopped after ${PARENT_TURN_CAP} assistant turns`),
    );

    // A graceful stop, not a thrown error.
    expect(result.service.getError()).toBeUndefined();

    const persistedAssistants = parseSessionEntries(result.sessionText)
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message)
      .filter((message) => message.role === "assistant");
    expect(persistedAssistants).toHaveLength(PARENT_TURN_CAP + 1);
    expect(JSON.stringify(persistedAssistants.at(-1)?.content)).toMatch(/Turn cap/);
  });
});
