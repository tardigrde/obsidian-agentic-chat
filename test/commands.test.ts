import { describe, expect, it } from "vitest";
import {
  parseSlashInput,
  resolveCommand,
  SLASH_COMMANDS,
  slashInputTailAfterFirst,
  visibleCommands,
} from "../src/ui/commands";

describe("SLASH_COMMANDS", () => {
  it("has unique canonical names", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it("has no alias colliding with a canonical name", () => {
    const names = new Set(SLASH_COMMANDS.map((c) => c.name));
    for (const command of SLASH_COMMANDS) {
      for (const alias of command.aliases ?? []) expect(names.has(alias)).toBe(false);
    }
  });
});

describe("visibleCommands", () => {
  it("hides deprecated/internal commands", () => {
    const names = visibleCommands().map((c) => c.name);
    expect(names).toContain("skill");
    expect(names).toContain("diagnostics");
    expect(names).toContain("steer");
    expect(names).toContain("follow-up");
    expect(names).toContain("redirect");
    expect(names).toContain("compact");
    expect(names).not.toContain("template");
  });
});

describe("resolveCommand", () => {
  it("resolves a canonical name case-insensitively", () => {
    expect(resolveCommand("NEW")?.name).toBe("new");
  });
  it("resolves an alias to its canonical command", () => {
    expect(resolveCommand("history")?.name).toBe("sessions");
    expect(resolveCommand("diag")?.name).toBe("diagnostics");
    expect(resolveCommand("followup")?.name).toBe("follow-up");
  });
  it("exposes /style as its own command (not a /config alias)", () => {
    expect(resolveCommand("style")?.name).toBe("style");
    expect(resolveCommand("mode")?.name).toBe("config");
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

  it("resolves aliases through the shared command catalog", () => {
    expect(parseSlashInput("/history").command?.name).toBe("sessions");
    expect(parseSlashInput("/followup remind me").command?.name).toBe("follow-up");
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
