import { describe, expect, it, vi } from "vitest";
import { ChatView } from "../src/ui/chat-view";
import { ChatActions } from "../src/ui/chat-actions";
import type { AgentService } from "../src/agent/agent-service";
import type { ChatTabs } from "../src/ui/chat-tabs";
import type { SlashContext } from "../src/ui/slash/context";
import { SLASH_COMMANDS } from "../src/ui/commands";

type Stubs = Record<string, ReturnType<typeof vi.fn>>;
type Dispatcher = { handleSlashCommand: (raw: string) => Promise<boolean> };

/**
 * Pins slash-command routing: each command name reaches its handler with the
 * same arguments. ChatView is built from its prototype with a `ChatActions`
 * owner whose handlers are stubbed, so only the dispatch is under test.
 */
function makeView(skills: Array<{ name: string }> = []) {
  const sessionsRun = vi.fn();
  const memoryRun = vi.fn();
  const actions = new ChatActions({
    slashCtx: () => ({}) as SlashContext,
    service: () => ({ getSkills: () => skills }) as unknown as AgentService,
    tabs: () => ({}) as ChatTabs,
    switchToTab: vi.fn(),
    loadConversation: vi.fn(),
    clearQueuedPrompt: vi.fn(),
    clearEmptyState: vi.fn(),
    renderErrorMessage: vi.fn(),
    renderInfoMessage: vi.fn(),
  });
  const stubs: Stubs = {
    newSession: vi.spyOn(actions, "newSession").mockResolvedValue(),
    runStyle: vi.spyOn(actions, "runStyle").mockResolvedValue(),
    runEffort: vi.spyOn(actions, "runEffort").mockReturnValue(undefined),
    switchModel: vi.spyOn(actions, "switchModel").mockResolvedValue(),
    showStatus: vi.spyOn(actions, "showStatus").mockReturnValue(undefined),
    runSemanticIndex: vi.spyOn(actions, "runSemanticIndex").mockResolvedValue(),
    runDoctor: vi.spyOn(actions, "runDoctor").mockResolvedValue(),
    showUsage: vi.spyOn(actions, "showUsage").mockReturnValue(undefined),
    runCompact: vi.spyOn(actions, "runCompact").mockResolvedValue(),
    exportSession: vi.spyOn(actions, "exportSession").mockResolvedValue(),
    runUndo: vi.spyOn(actions, "runUndo").mockResolvedValue(),
    runSkill: vi.spyOn(actions, "runSkill").mockResolvedValue(),
    runAgent: vi.spyOn(actions, "runAgent").mockResolvedValue(),
    runInit: vi.spyOn(actions, "runInit").mockResolvedValue(),
    showHelp: vi.spyOn(actions, "showHelp").mockReturnValue(undefined),
    showRetiredCommandHint: vi.spyOn(actions, "showRetiredCommandHint").mockReturnValue(false),
  };
  vi.spyOn(actions, "runSessions").mockImplementation((arg) => sessionsRun(arg));
  vi.spyOn(actions, "runMemory").mockImplementation((arg) => memoryRun(arg));
  const view = Object.assign(Object.create(ChatView.prototype), {}) as Dispatcher;
  Object.defineProperty(view, "actions", { value: actions });
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
