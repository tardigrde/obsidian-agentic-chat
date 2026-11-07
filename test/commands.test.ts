import { describe, expect, it } from "vitest";
import {
  parseSlashInput,
  resolveCommand,
  SLASH_COMMANDS,
  slashInputTailAfterFirst,
  visibleCommands,
} from "../src/ui/commands";

const REMOVED_COMMANDS = ["config", "project"] as const;
const REMOVED_ALIASES = [
  "mode",
  "projects",
  "history",
  "semindex",
  "adddir",
  "working-dirs",
  "todos",
  "followup",
  "thinking",
] as const;
const SUPPORTED_COMMANDS = [
  "usage",
  "doctor",
  "style",
  "add-dir",
  "dirs",
  "todo",
  "follow-up",
  "steer",
  "redirect",
  "plan",
  "sessions",
  "semantic-index",
  "effort",
] as const;

describe("SLASH_COMMANDS", () => {
  it("has unique canonical names", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("visibleCommands", () => {
  it("lists only the supported commands", () => {
    const names = visibleCommands().map((c) => c.name);
    expect(names).toEqual(SLASH_COMMANDS.map((c) => c.name));
    for (const removed of REMOVED_COMMANDS) expect(names).not.toContain(removed);
  });
});

describe("resolveCommand", () => {
  it("resolves a canonical name case-insensitively", () => {
    expect(resolveCommand("NEW")?.name).toBe("new");
  });

  it("resolves every supported command", () => {
    for (const name of SUPPORTED_COMMANDS) expect(resolveCommand(name)?.name).toBe(name);
  });

  it.each([...REMOVED_COMMANDS, ...REMOVED_ALIASES])("does not resolve the removed word %s", (word) => {
    expect(resolveCommand(word)).toBeUndefined();
    expect(parseSlashInput(`/${word}`).command).toBeUndefined();
  });

  it("drops the retired diagnostics/diag aliases", () => {
    expect(resolveCommand("diag")).toBeUndefined();
    expect(resolveCommand("diagnostics")).toBeUndefined();
    expect(resolveCommand("doctor")?.name).toBe("doctor");
  });

  it("returns undefined for an unknown word", () => {
    expect(resolveCommand("nope")).toBeUndefined();
  });
});

describe("parseSlashInput", () => {
  it("parses canonical commands with trimmed argument strings", () => {
    const input = parseSlashInput("/semantic-index start folder Research/Notes");

    expect(input.word).toBe("semantic-index");
    expect(input.command?.name).toBe("semantic-index");
    expect(input.argString).toBe("start folder Research/Notes");
    expect(input.args).toEqual(["start", "folder", "Research/Notes"]);
  });

  it("keeps multiline argument tails for commands such as init and compact", () => {
    const input = parseSlashInput("/compact preserve\nopen bugs");

    expect(input.command?.name).toBe("compact");
    expect(input.argString).toBe("preserve\nopen bugs");
  });

  it("keeps alias-shaped words unresolved", () => {
    expect(parseSlashInput("/history").command).toBeUndefined();
    expect(parseSlashInput("/followup remind me").command).toBeUndefined();
  });

  it("keeps bare skill names unresolved for ChatView fallback handling", () => {
    const input = parseSlashInput("/daily-summary Inbox.md");

    expect(input.word).toBe("daily-summary");
    expect(input.command).toBeUndefined();
    expect(input.argString).toBe("Inbox.md");
  });

  it("returns the tail after the first positional argument", () => {
    const input = parseSlashInput("/skill   summarize   Daily.md with context");

    expect(input.args).toEqual(["summarize", "Daily.md", "with", "context"]);
    expect(slashInputTailAfterFirst(input)).toBe("Daily.md with context");
    expect(slashInputTailAfterFirst(parseSlashInput("/skill"))).toBe("");
  });
});
