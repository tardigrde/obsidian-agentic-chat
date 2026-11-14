import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/settings-schema";
import { resolveCommand, retiredCommandHint, SLASH_COMMANDS } from "../src/ui/commands";

/**
 * Witness for the November 2026 feature cut
 * (docs/development/feature-cut-2026-11.md). Each test proves that one removed
 * entry point is gone.
 */
const commandNames = (): string[] => SLASH_COMMANDS.map((command) => command.name);

function mergedKeys(stored: Record<string, unknown>): string[] {
  return Object.keys(mergeSettings(stored as never));
}

describe("feature cut 2026-11: output styles", () => {
  it("does not register /style and shows a retired hint", () => {
    expect(commandNames()).not.toContain("style");
    expect(resolveCommand("style")).toBeUndefined();
    expect(retiredCommandHint("style")).toContain("/style was removed");
  });

  it("drops the outputStyle setting on load", () => {
    expect(Object.keys(DEFAULT_SETTINGS)).not.toContain("outputStyle");
    expect(mergedKeys({ outputStyle: "learning" })).not.toContain("outputStyle");
  });
});
