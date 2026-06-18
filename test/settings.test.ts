import { describe, expect, it } from "vitest";
import { mergeSettings } from "../src/settings";

describe("mergeSettings — working directories", () => {
  it("defaults to an empty working set", () => {
    expect(mergeSettings(null).approval.workingDirs).toEqual([]);
    expect(mergeSettings({}).approval.workingDirs).toEqual([]);
  });

  it("keeps a stored string[] working set", () => {
    const merged = mergeSettings({ approval: { mutating: "ask", perTool: {}, workingDirs: ["Notes", "Work"] } });
    expect(merged.approval.workingDirs).toEqual(["Notes", "Work"]);
  });

  it("heals a malformed working set down to its string entries", () => {
    const merged = mergeSettings({
      // A corrupted persisted value: non-array / mixed types must not reach the gate.
      approval: { mutating: "ask", perTool: {}, workingDirs: ["ok", 3, null, "two"] as unknown as string[] },
    });
    expect(merged.approval.workingDirs).toEqual(["ok", "two"]);
  });

  it("treats a non-array working set as empty", () => {
    const merged = mergeSettings({
      approval: { mutating: "ask", perTool: {}, workingDirs: "Notes" as unknown as string[] },
    });
    expect(merged.approval.workingDirs).toEqual([]);
  });
});

describe("mergeSettings — durable memory", () => {
  it("defaults to an empty store", () => {
    expect(mergeSettings(null).memory).toBe("");
    expect(mergeSettings({}).memory).toBe("");
  });

  it("keeps a stored string memory", () => {
    expect(mergeSettings({ memory: "- prefers terse answers" }).memory).toBe("- prefers terse answers");
  });

  it("heals a non-string memory back to empty", () => {
    const merged = mergeSettings({ memory: { not: "a string" } as unknown as string });
    expect(merged.memory).toBe("");
  });
});

