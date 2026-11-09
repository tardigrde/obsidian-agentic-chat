import { describe, expect, it } from "vitest";
import { mergeSettings, retiredSettingsNotices, type AgenticChatSettings } from "../src/settings-schema";
import { retiredCommandHint } from "../src/ui/commands";

function load(stored: unknown): AgenticChatSettings {
  return mergeSettings(stored as Partial<AgenticChatSettings>);
}

describe("retiredSettingsNotices", () => {
  it("names the user's working directories and points at Ignored files", () => {
    const notices = retiredSettingsNotices({
      approval: { mutating: "ask", perTool: {}, workingDirs: ["Projects", "Inbox"] },
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("Projects");
    expect(notices[0]).toContain("Inbox");
    expect(notices[0]).toContain("Working directories were removed in this version.");
    expect(notices[0]).toContain("The agent can now read the whole vault without asking.");
    expect(notices[0]).toContain("Settings → Advanced → Ignored files");
  });

  it("still reports an empty or malformed workingDirs value without crashing", () => {
    for (const workingDirs of [[], "Notes", null, { path: "Notes" }, [3, "Work"]]) {
      const notices = retiredSettingsNotices({ approval: { workingDirs } });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("Working directories were removed");
    }
    expect(retiredSettingsNotices({ approval: { workingDirs: [3, "Work"] } })[0]).toContain("Work");
  });

  it("says a retired plan mode now starts in Safe mode", () => {
    const notices = retiredSettingsNotices({ mode: "plan" });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/Plan mode was removed/);
    expect(notices[0]).toContain("Safe mode");
    expect(load({ mode: "plan" }).mode).toBe("safe");
  });

  it("reports both changes for a data.json with both", () => {
    expect(retiredSettingsNotices({ mode: "plan", approval: { workingDirs: ["Projects"] } })).toHaveLength(2);
  });

  it("reports nothing for current settings or no data", () => {
    expect(retiredSettingsNotices(null)).toEqual([]);
    expect(retiredSettingsNotices(undefined)).toEqual([]);
    expect(retiredSettingsNotices({ mode: "safe", approval: { mutating: "ask", perTool: {} } })).toEqual([]);
    expect(retiredSettingsNotices({ mode: "yolo" })).toEqual([]);
  });

  it("does not report again on the second load of the migrated data", () => {
    const stored = { mode: "plan", approval: { mutating: "ask", perTool: {}, workingDirs: ["Projects", "Inbox"] } };
    expect(retiredSettingsNotices(stored)).toHaveLength(2);
    // First load heals and the plugin saves the result; the next load reads that saved shape.
    const saved: unknown = JSON.parse(JSON.stringify(load(stored)));
    expect(retiredSettingsNotices(saved)).toEqual([]);
    expect(retiredSettingsNotices(JSON.parse(JSON.stringify(load(saved))))).toEqual([]);
  });
});

describe("retiredCommandHint", () => {
  it("names the replacement for each retired command", () => {
    expect(retiredCommandHint("steer")).toBe("/steer was removed: press Enter while the agent responds to steer.");
    expect(retiredCommandHint("follow-up")).toMatch(/Queue/);
    expect(retiredCommandHint("followup")).toMatch(/Queue/);
    expect(retiredCommandHint("redirect")).toMatch(/Stop/);
    expect(retiredCommandHint("history")).toMatch(/\/sessions/);
    expect(retiredCommandHint("semindex")).toMatch(/\/semantic-index/);
    expect(retiredCommandHint("thinking")).toMatch(/\/effort/);
    expect(retiredCommandHint("add-dir")).toMatch(/Ignored files/);
  });

  it("covers every command retired by the product cuts, case-insensitively", () => {
    const retired = [
      "steer", "follow-up", "followup", "redirect", "config", "mode", "history", "semindex",
      "thinking", "todo", "todos", "add-dir", "dirs", "working-dirs",
    ];
    for (const word of retired) {
      const hint = retiredCommandHint(word);
      expect(hint, word).toMatch(new RegExp(`^/${word} was removed`));
      expect(retiredCommandHint(word.toUpperCase()), word).toBe(hint);
    }
  });

  it("returns nothing for live commands, unknown words, and /plan (still a plain prompt)", () => {
    for (const word of ["new", "sessions", "effort", "semantic-index", "help", "my-skill", "", "constructor", "plan"]) {
      expect(retiredCommandHint(word)).toBeUndefined();
    }
  });
});
