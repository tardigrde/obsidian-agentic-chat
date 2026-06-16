import { describe, expect, it } from "vitest";
import { resolveCommand, SLASH_COMMANDS, visibleCommands } from "../src/ui/commands";

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
    expect(names).not.toContain("template");
  });
});

describe("resolveCommand", () => {
  it("resolves a canonical name case-insensitively", () => {
    expect(resolveCommand("NEW")?.name).toBe("new");
  });
  it("resolves an alias to its canonical command", () => {
    expect(resolveCommand("history")?.name).toBe("sessions");
  });
  it("exposes /style as its own command (not a /config alias)", () => {
    expect(resolveCommand("style")?.name).toBe("style");
    expect(resolveCommand("mode")?.name).toBe("config");
  });
  it("returns undefined for an unknown word", () => {
    expect(resolveCommand("nope")).toBeUndefined();
  });
});
