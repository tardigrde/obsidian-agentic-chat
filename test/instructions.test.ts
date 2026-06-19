import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import { formatInstructionsOverlay, INSTRUCTION_FILES, loadVaultInstructions } from "../src/agent/instructions";

/** Minimal DataAdapter stub backed by an in-memory path → content map. */
function fakeAdapter(files: Record<string, string>): DataAdapter {
  return {
    exists: async (path: string) => path in files,
    read: async (path: string) => files[path] ?? "",
  } as unknown as DataAdapter;
}

describe("loadVaultInstructions", () => {
  it("returns empty when no instruction file exists", async () => {
    expect(await loadVaultInstructions(fakeAdapter({}))).toBe("");
  });

  it("reads AGENTS.md when present", async () => {
    const adapter = fakeAdapter({ "AGENTS.md": "# My vault\nagent should X" });
    expect(await loadVaultInstructions(adapter)).toBe("# My vault\nagent should X");
  });

  it("falls back to CLAUDE.md, then GEMINI.md", async () => {
    expect(await loadVaultInstructions(fakeAdapter({ "CLAUDE.md": "c" }))).toBe("c");
    expect(await loadVaultInstructions(fakeAdapter({ "GEMINI.md": "g" }))).toBe("g");
    expect(await loadVaultInstructions(fakeAdapter({ "CLAUDE.md": "c", "GEMINI.md": "g" }))).toBe("c");
  });

  it("AGENTS.md wins over CLAUDE.md and GEMINI.md", async () => {
    const adapter = fakeAdapter({ "AGENTS.md": "a", "CLAUDE.md": "c", "GEMINI.md": "g" });
    expect(await loadVaultInstructions(adapter)).toBe("a");
  });

  it("precedence order is AGENTS → CLAUDE → GEMINI", () => {
    expect([...INSTRUCTION_FILES]).toEqual(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
  });
});

describe("formatInstructionsOverlay", () => {
  it("produces no overlay for blank content", () => {
    expect(formatInstructionsOverlay("")).toBe("");
    expect(formatInstructionsOverlay("   \n ")).toBe("");
  });

  it("wraps content under a Project instructions heading with a standing-context note", () => {
    const overlay = formatInstructionsOverlay("# My vault\n- be terse");
    expect(overlay.startsWith("## Project instructions")).toBe(true);
    expect(overlay).toContain("standing context");
    expect(overlay).toContain("# My vault\n- be terse");
  });
});
