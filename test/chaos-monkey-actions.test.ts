import { describe, expect, it } from "vitest";
import { PARENT_TURN_CAP } from "../src/agent/turn-cap";
import { CHAOS_TARGETS } from "../scripts/chaos/monkey-core";

/**
 * Load the catalog dynamically so the witness runner can revert the module and
 * still execute an assertion. The target-list check runs before the import: at
 * base the new targets are absent, so every test fails on `expect` instead of a
 * loader marker or a plain Error.
 */
async function loadActions(): Promise<typeof import("../scripts/chaos/monkey-actions")> {
  expect(CHAOS_TARGETS).toContain("retired-commands");
  expect(CHAOS_TARGETS).toContain("mcp-lifecycle");
  try {
    return await import("../scripts/chaos/monkey-actions");
  } catch {
    throw new Error("expected the chaos action catalog module to exist");
  }
}

const NEW_TARGETS = [
  "retired-commands",
  "steer",
  "queue",
  "stop-send",
  "max-turns",
  "settings-persistence",
  "approval-paths",
  "session-reload",
  "large-input",
  "mcp-lifecycle",
] as const;

const caps = { maxSteps: 12, maxSeconds: 60, maxCalls: 6, maxTokens: 0 };

describe("chaos action catalog", () => {
  it("registers every focused target and every new hostile action", async () => {
    const { chaosActionCatalog } = await loadActions();
    const catalogIds = new Set(chaosActionCatalog().map((action) => action.id));
    for (const target of NEW_TARGETS) {
      expect(CHAOS_TARGETS).toContain(target);
      expect(catalogIds).toContain(target);
    }
  });

  it("covers every retired command exactly once", async () => {
    const { RETIRED_COMMANDS } = await loadActions();
    expect([...RETIRED_COMMANDS]).toEqual([
      "/steer",
      "/follow-up",
      "/redirect",
      "/todo",
      "/todos",
      "/plan",
      "/mode",
      "/config",
      "/project",
    ]);
  });

  it("gives every focused target a non-empty sequence that starts with its named action", async () => {
    const { focusedSequence } = await loadActions();
    for (const target of CHAOS_TARGETS) {
      const sequence = focusedSequence(target);
      expect(sequence.length).toBeGreaterThan(0);
      if (NEW_TARGETS.includes(target as (typeof NEW_TARGETS)[number])) {
        expect(sequence[0].id).toBe(target);
      }
    }
  });

  it("keeps the existing focused surfaces unchanged", async () => {
    const { focusedSequence } = await loadActions();
    expect(focusedSequence("composer").map((action) => action.id)).toEqual([
      "composer-prompt",
      "slash-help",
      "slash-dirs",
    ]);
    expect(focusedSequence("notes").map((action) => action.id)).toEqual(["notes-write-1", "notes-write-2"]);
    expect(focusedSequence("mcp").map((action) => action.id)).toEqual(["mcp-surface", "settings-tabs"]);
  });
});

describe("chaos generic sampling", () => {
  it("is deterministic for a given seed", async () => {
    const { genericSequence } = await loadActions();
    expect(genericSequence(caps, 42)).toEqual(genericSequence(caps, 42));
  });

  it("samples the new hostile actions across seeds instead of a note-write bias", async () => {
    const { genericSequence } = await loadActions();
    const seen = new Set<string>();
    let notes = 0;
    let steps = 0;
    for (let seed = 1; seed <= 80; seed += 1) {
      for (const action of genericSequence(caps, seed)) {
        seen.add(action.kind);
        if (action.kind === "notes-write") notes += 1;
        steps += 1;
      }
    }
    for (const target of NEW_TARGETS) {
      expect(seen).toContain(target);
    }
    // The old stream forced notes on 40% of steps; one slot in the pool must
    // stay well below that across a broad sample.
    expect(notes / steps).toBeLessThan(0.15);
  });
});

describe("chaos scripted turns", () => {
  it("covers every new live action with turns", async () => {
    const { focusedSequence, scriptedTurnsForAction } = await loadActions();
    for (const target of NEW_TARGETS) {
      const action = focusedSequence(target)[0];
      const turns = scriptedTurnsForAction(action);
      if (action.kind === "settings-persistence" || action.kind === "mcp-lifecycle") {
        expect(turns).toEqual([]);
      } else {
        expect(turns.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses the full parent turn budget plus one beyond-cap turn for max-turns", async () => {
    const { focusedSequence, scriptedTurnsForAction } = await loadActions();
    const turns = scriptedTurnsForAction(focusedSequence("max-turns")[0]);
    expect(turns).toHaveLength(PARENT_TURN_CAP + 1);
    expect(turns.at(-1)?.label).toContain("beyond cap");
  });

  it("holds steering and queue turns, and delays the stop turn so abort can win", async () => {
    const { focusedSequence, scriptedTurnsForAction } = await loadActions();
    expect(scriptedTurnsForAction(focusedSequence("steer")[0])[0].hold).toBe(true);
    expect(scriptedTurnsForAction(focusedSequence("queue")[0])[0].hold).toBe(true);
    expect(scriptedTurnsForAction(focusedSequence("stop-send")[0])[0].delayMs).toBeGreaterThanOrEqual(30_000);
  });

  it("scripts both approval paths and both notes", async () => {
    const { ALLOWED_NOTE, DENIED_NOTE, focusedSequence, scriptedTurnsForAction } = await loadActions();
    const serialized = JSON.stringify(scriptedTurnsForAction(focusedSequence("approval-paths")[0]));
    expect(serialized).toContain(DENIED_NOTE);
    expect(serialized).toContain(ALLOWED_NOTE);
  });

  it("keeps the model-call count in sync with the scripted turns that consume calls", async () => {
    const { focusedSequence, modelCallsFor, scriptedTurnsForAction } = await loadActions();
    for (const target of CHAOS_TARGETS) {
      for (const action of focusedSequence(target)) {
        const turns = scriptedTurnsForAction(action);
        if (action.kind === "max-turns") {
          expect(modelCallsFor(action)).toBe(PARENT_TURN_CAP);
          expect(turns).toHaveLength(PARENT_TURN_CAP + 1);
        } else if (
          action.kind !== "settings" &&
          action.kind !== "mcp" &&
          action.kind !== "settings-persistence" &&
          action.kind !== "mcp-lifecycle" &&
          action.kind !== "slash"
        ) {
          expect(modelCallsFor(action)).toBe(turns.length);
        }
      }
    }
  });

  it("concatenates turns in sequence order", async () => {
    const { RETIRED_COMMANDS, focusedSequence, scriptedTurnsFor } = await loadActions();
    const sequence = focusedSequence("retired-commands");
    const turns = scriptedTurnsFor(sequence);
    expect(turns).toHaveLength(RETIRED_COMMANDS.length);
    expect(turns[0].label).toContain(RETIRED_COMMANDS[0]);
    expect(turns.at(-1)?.label).toContain(RETIRED_COMMANDS.at(-1));
  });
});
