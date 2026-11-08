import { PARENT_TURN_CAP } from "../../src/agent/turn-cap";
import type { ChaosCaps, ChaosTarget } from "./monkey-core";

/**
 * Pure action catalog for the chaos-monkey driver.
 *
 * The runner, the in-app driver, and the unit tests share this module so a
 * target cannot exist in one place and silently miss the other. No DOM, no
 * Obsidian API, no secrets: only names, prompts, and the scripted-turn shape a
 * dry run replays.
 */

export const RETIRED_COMMANDS = [
  "/steer",
  "/follow-up",
  "/redirect",
  "/todo",
  "/todos",
  "/plan",
  "/mode",
  "/config",
  "/project",
] as const;

export type ChaosActionKind =
  | "prompt"
  | "slash"
  | "settings"
  | "mcp"
  | "notes-write"
  | "retired-commands"
  | "steer"
  | "queue"
  | "stop-send"
  | "max-turns"
  | "settings-persistence"
  | "approval-paths"
  | "session-reload"
  | "large-input"
  | "mcp-lifecycle";

export type ChaosSurface = ChaosTarget | "slash-commands";

export type ChaosAction = {
  id: string;
  surface: ChaosSurface;
  kind: ChaosActionKind;
  description: string;
  prompt?: string;
  notePath?: string;
};

export type ChaosScriptedTurn = {
  label: string;
  stopReason: "stop" | "length" | "toolUse";
  content: Array<Record<string, unknown>>;
  hold?: boolean;
  emitUpdates?: boolean;
  delayMs?: number;
};

export const DENIED_NOTE = "Chaos/Denied by chaos.md";
export const ALLOWED_NOTE = "Chaos/Allowed by chaos.md";

function textTurn(label: string, text: string, extra: Partial<ChaosScriptedTurn> = {}): ChaosScriptedTurn {
  return {
    ...extra,
    label,
    stopReason: "stop",
    content: [{ type: "text", text }],
  };
}

function writeTurn(label: string, path: string, content: string): ChaosScriptedTurn {
  return {
    label,
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: `${label}-write`, name: "write", arguments: { path, content } }],
  };
}

/** One base action per stable surface. Notes are instantiated separately. */
export function chaosActionCatalog(): ChaosAction[] {
  return [
    {
      id: "composer-prompt",
      surface: "composer",
      kind: "prompt",
      description: "send one free-form prompt and read the answer",
      prompt: "In one short sentence, say what you can do in this Obsidian vault.",
    },
    {
      id: "slash-help",
      surface: "slash-commands",
      kind: "slash",
      description: "run /help in the composer",
      prompt: "/help",
    },
    {
      id: "slash-status",
      surface: "slash-commands",
      kind: "slash",
      description: "run /status in the composer",
      prompt: "/status",
    },
    {
      id: "settings-tabs",
      surface: "settings",
      kind: "settings",
      description: "open Agentic Chat settings, switch every tab, and toggle MCP",
    },
    {
      id: "mcp-surface",
      surface: "mcp",
      kind: "mcp",
      description: "open Advanced, enable MCP, add a server, and read the row",
    },
    {
      id: "retired-commands",
      surface: "retired-commands",
      kind: "retired-commands",
      description: "send every retired slash command and assert a clean response",
    },
    {
      id: "steer",
      surface: "steer",
      kind: "steer",
      description: "steer a running turn after its first tool call",
      prompt: "Read Welcome.md, Notes/Seed.md, and Chaos Scratch.md one after another with separate read calls, then summarize them in one sentence.",
    },
    {
      id: "queue",
      surface: "queue",
      kind: "queue",
      description: "queue a draft while a turn runs, then edit and send it at turn end",
      prompt: "Read Welcome.md, Notes/Seed.md, and Chaos Scratch.md one after another with separate read calls, then summarize them in one sentence.",
    },
    {
      id: "stop-send",
      surface: "stop-send",
      kind: "stop-send",
      description: "stop a running turn and send the held draft as a replacement",
      prompt: "Read Welcome.md, Notes/Seed.md, and Chaos Scratch.md one after another with separate read calls, then write a long summary.",
    },
    {
      id: "max-turns",
      surface: "max-turns",
      kind: "max-turns",
      description: "force more tool iterations than the assistant-turn cap allows",
      prompt:
        "Do not summarize and do not stop. Call the read tool on Welcome.md, then Notes/Seed.md, then Chaos Scratch.md, then repeat that cycle forever. Each call must be its own assistant turn. Make at least 40 read calls. The host will stop you when the turn budget ends.",
    },
    {
      id: "settings-persistence",
      surface: "settings-persistence",
      kind: "settings-persistence",
      description: "change one value per tab, then reload Obsidian and the plugin",
    },
    {
      id: "approval-paths",
      surface: "approval-paths",
      kind: "approval-paths",
      description: "deny one write and allow the next, then check both notes",
    },
    {
      id: "session-reload",
      surface: "session-reload",
      kind: "session-reload",
      description: "switch sessions, reload the plugin, and re-open the earlier transcript",
    },
    {
      id: "large-input",
      surface: "large-input",
      kind: "large-input",
      description: "paste a very large prompt and check overflow and responsiveness",
    },
    {
      id: "mcp-lifecycle",
      surface: "mcp-lifecycle",
      kind: "mcp-lifecycle",
      description: "add, test, and remove one MCP server and check saved settings",
    },
  ];
}

export function noteAction(index: number): ChaosAction {
  return {
    id: `notes-write-${index}`,
    surface: "notes",
    kind: "notes-write",
    description: "ask the model to create a note, approve the write, and read it back",
    prompt: `Create the note Chaos/Chaos ${index}.md with exactly this content: chaos monkey step ${index}`,
    notePath: `Chaos/Chaos ${index}.md`,
  };
}

function catalogAction(id: string): ChaosAction {
  const action = chaosActionCatalog().find((candidate) => candidate.id === id);
  if (!action) throw new Error(`unknown chaos action: ${id}`);
  return action;
}

/** Focused sequences. One named target selects one stable sequence. */
export function focusedSequence(target: ChaosTarget): ChaosAction[] {
  switch (target) {
    case "composer":
      return [catalogAction("composer-prompt"), catalogAction("slash-help"), catalogAction("slash-status")];
    case "settings":
      return [catalogAction("settings-tabs")];
    case "mcp":
      return [catalogAction("mcp-surface"), catalogAction("settings-tabs")];
    case "notes":
      return [noteAction(1), noteAction(2)];
    default:
      return [catalogAction(target)];
  }
}

/** Small deterministic PRNG. A given seed always produces the same sequence. */
export function chaosRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

/**
 * Generic mode samples every action once per roll from one flat pool. Notes are
 * one slot among the catalog instead of the old 40% branch, so the newer
 * hostile actions appear across seeds while note writes stay possible.
 */
export function genericSequence(caps: ChaosCaps, seed: number): ChaosAction[] {
  const base = chaosActionCatalog();
  const noteSlot: ChaosAction = {
    id: "notes-write",
    surface: "notes",
    kind: "notes-write",
    description: "ask the model to create a note, approve the write, and read it back",
  };
  const pool = [...base, noteSlot];
  const random = chaosRng(seed);
  const sequence: ChaosAction[] = [];
  let notes = 0;
  for (let index = 0; index < caps.maxSteps; index += 1) {
    const action = pool[Math.floor(random() * pool.length)];
    if (action.kind === "notes-write") {
      notes += 1;
      sequence.push(noteAction(notes));
    } else {
      sequence.push(action);
    }
  }
  return sequence;
}

/**
 * Scripted model turns for a dry run, in call order. Every new action has at
 * least one turn unless it is pure UI (settings, MCP lifecycle).
 */
export function scriptedTurnsFor(sequence: ChaosAction[]): ChaosScriptedTurn[] {
  const turns: ChaosScriptedTurn[] = [];
  for (const action of sequence) turns.push(...scriptedTurnsForAction(action));
  return turns;
}

export function scriptedTurnsForAction(action: ChaosAction): ChaosScriptedTurn[] {
  switch (action.kind) {
    case "prompt":
      return [textTurn(`${action.id} reply`, `Chaos reply for ${action.id}.`)];
    case "retired-commands":
      return RETIRED_COMMANDS.map((command) =>
        textTurn(`${action.id}:${command}`, `Chaos reply for the retired command ${command}.`),
      );
    case "notes-write":
      return [
        writeTurn(`${action.id} write`, action.notePath ?? "Chaos/Chaos.md", "chaos monkey was here"),
        textTurn(`${action.id} final`, `Created ${action.notePath ?? "the note"}.`),
      ];
    case "steer":
      return [
        {
          label: `${action.id} tool`,
          stopReason: "toolUse",
          emitUpdates: true,
          hold: true,
          content: [{ type: "toolCall", id: `${action.id}-tool`, name: "read", arguments: { path: "Welcome.md" } }],
        },
        textTurn(`${action.id} final`, "Steered answer used the added constraint."),
      ];
    case "queue":
      return [
        textTurn(`${action.id} held`, "Initial queued answer.", { hold: true }),
        textTurn(`${action.id} final`, "Queued answer used the edited draft."),
      ];
    case "stop-send":
      return [
        textTurn(`${action.id} held`, "The stopped answer must not settle.", { delayMs: 30_000 }),
        textTurn(`${action.id} replacement`, "Replacement answer after stop."),
      ];
    case "max-turns": {
      const turns: ChaosScriptedTurn[] = [];
      for (let index = 0; index < PARENT_TURN_CAP; index += 1) {
        turns.push(
          writeTurn(
            `${action.id} turn ${index}`,
            `Chaos/Turn cap ${index}.md`,
            `turn ${index}`,
          ),
        );
      }
      // The turn cap must fire before this turn is requested.
      turns.push(textTurn(`${action.id} beyond cap`, "The turn cap did not stop the run."));
      return turns;
    }
    case "approval-paths":
      return [
        writeTurn(`${action.id} denied`, DENIED_NOTE, "denied write"),
        textTurn(`${action.id} denied final`, "The denied write was not applied."),
        writeTurn(`${action.id} allowed`, ALLOWED_NOTE, "allowed write"),
        textTurn(`${action.id} allowed final`, "The allowed write was applied."),
      ];
    case "session-reload":
      return [
        textTurn(`${action.id} first`, "First session answer before the reload."),
        textTurn(`${action.id} second`, "Second session answer before the reload."),
      ];
    case "large-input":
      return [
        textTurn(`${action.id} first`, "Large input answer."),
        textTurn(`${action.id} second`, "The composer is still responsive."),
      ];
    case "slash":
    case "settings":
    case "mcp":
    case "settings-persistence":
    case "mcp-lifecycle":
      return [];
  }
}

/** Model calls one action consumes, used for the cap counters and budgets. */
export function modelCallsFor(action: ChaosAction): number {
  switch (action.kind) {
    case "retired-commands":
      return RETIRED_COMMANDS.length;
    case "notes-write":
    case "steer":
    case "queue":
    case "stop-send":
    case "session-reload":
    case "large-input":
      return 2;
    case "approval-paths":
      return 4;
    case "max-turns":
      return PARENT_TURN_CAP;
    case "prompt":
      return 1;
    default:
      return 0;
  }
}

export type ChaosBudgetStep =
  | { action: ChaosAction; status: "run"; reserved: number; remaining: number }
  | { action: ChaosAction; status: "skipped"; needed: number; remaining: number; reason: string };

export type ChaosBudgetPlan = {
  steps: ChaosBudgetStep[];
  /** Set when the plan stopped because nothing left in the sequence fits. */
  stopReason?: "max-calls";
};

/**
 * Reserve each action's whole `modelCallsFor` estimate against `--max-calls`.
 *
 * An action that does not fit becomes a skipped step instead of ending the run.
 * The plan keeps going while a later action still fits. It stops with
 * `max-calls` only when no remaining action fits. Dry runs use the same rule:
 * scripted turns consume the call budget but never spend tokens, and the caller
 * installs scripted turns only for the planned `run` steps so the replay stays
 * aligned.
 */
export function planChaosBudget(sequence: ChaosAction[], maxCalls: number, calls = 0): ChaosBudgetPlan {
  const steps: ChaosBudgetStep[] = [];
  let spent = Math.max(0, calls);
  for (let index = 0; index < sequence.length; index += 1) {
    const action = sequence[index];
    const remaining = Math.max(0, maxCalls - spent);
    const needed = modelCallsFor(action);
    if (needed <= remaining) {
      steps.push({ action, status: "run", reserved: needed, remaining });
      spent += needed;
      continue;
    }
    const laterFits = sequence.slice(index + 1).some((later) => modelCallsFor(later) <= remaining);
    steps.push({
      action,
      status: "skipped",
      needed,
      remaining,
      reason: `needs ${needed} model calls, ${remaining} remaining`,
    });
    if (!laterFits) return { steps, stopReason: "max-calls" };
  }
  return { steps };
}
