import { describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/ui/chat-view";
import { SLASH_COMMANDS } from "../src/ui/commands";

type Stubs = Record<string, ReturnType<typeof vi.fn>>;
type Dispatcher = { handleSlashCommand: (raw: string) => Promise<boolean> };

/**
 * Pins slash-command routing: each command name reaches its handler with the
 * same arguments. ChatView is built from its prototype with every handler
 * stubbed, so only the dispatch is under test.
 */
function makeView(skills: Array<{ name: string }> = []) {
  const sessionsRun = vi.fn();
  const memoryRun = vi.fn();
  const stubs: Stubs = {
    newSession: vi.fn(),
    runStyle: vi.fn(),
    runEffort: vi.fn(),
    switchModel: vi.fn(),
    showStatus: vi.fn(),
    runSemanticIndex: vi.fn(),
    runDoctor: vi.fn(),
    showUsage: vi.fn(),
    runCompact: vi.fn(),
    exportSession: vi.fn(),
    runUndo: vi.fn(),
    runSkill: vi.fn(),
    runAgent: vi.fn(),
    runInit: vi.fn(),
    showHelp: vi.fn(),
    showRetiredCommandHint: vi.fn(() => false),
  };
  const view = Object.assign(Object.create(ChatView.prototype), {
    ...stubs,
    createSessionWorkflow: () => ({ run: sessionsRun }),
    createMemoryWorkflow: () => ({ run: memoryRun }),
  }) as Dispatcher;
  // `service` is a getter on ChatView; shadow it on the instance.
  Object.defineProperty(view, "service", { value: { getSkills: () => skills } });
  return { view, stubs, sessionsRun, memoryRun };
}

// Command name -> [handler key, expected arguments] for the input `/<name> a b`.
const ROUTES: Record<string, [string, unknown[]]> = {
  new: ["newSession", []],
  style: ["runStyle", ["a b"]],
  effort: ["runEffort", ["a b"]],
  sessions: ["sessionsRun", ["a b"]],
  model: ["switchModel", []],
  status: ["showStatus", []],
  memory: ["memoryRun", ["a b"]],
  "semantic-index": ["runSemanticIndex", ["a b"]],
  doctor: ["runDoctor", []],
  usage: ["showUsage", []],
  compact: ["runCompact", ["a b"]],
  export: ["exportSession", []],
  undo: ["runUndo", []],
  skill: ["runSkill", ["a", "b"]],
  agent: ["runAgent", ["a", "b"]],
  init: ["runInit", ["a b"]],
  help: ["showHelp", []],
};

describe("slash command dispatch", () => {
  it("has a route for every command in the table", () => {
    expect(Object.keys(ROUTES).sort()).toEqual(SLASH_COMMANDS.map((command) => command.name).sort());
  });

  for (const [name, [handler, args]] of Object.entries(ROUTES)) {
    it(`/${name} reaches ${handler}`, async () => {
      const { view, stubs, sessionsRun, memoryRun } = makeView();
      const all: Stubs = { ...stubs, sessionsRun, memoryRun };
      await expect(view.handleSlashCommand(`/${name} a b`)).resolves.toBe(true);
      expect(all[handler]).toHaveBeenCalledTimes(1);
      expect(all[handler]).toHaveBeenCalledWith(...args);
      const others = Object.entries(all).filter(([key]) => key !== handler);
      for (const [key, fn] of others) expect(fn, key).not.toHaveBeenCalled();
    });
  }

  it("matches the command word case-insensitively", async () => {
    const { view, stubs } = makeView();
    await expect(view.handleSlashCommand("/HELP")).resolves.toBe(true);
    expect(stubs.showHelp).toHaveBeenCalledTimes(1);
  });

  it("runs a bare /<skill-name> as that skill", async () => {
    const { view, stubs } = makeView([{ name: "Daily" }]);
    await expect(view.handleSlashCommand("/daily x y")).resolves.toBe(true);
    expect(stubs.runSkill).toHaveBeenCalledWith("Daily", "x y", "/daily x y");
  });

  it("falls back to the retired-command hint for an unknown word", async () => {
    const { view, stubs } = makeView();
    await expect(view.handleSlashCommand("/todo")).resolves.toBe(false);
    expect(stubs.showRetiredCommandHint).toHaveBeenCalledWith("todo");
  });
});
