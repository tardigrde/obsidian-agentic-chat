import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import {
  formatInstructionsOverlay,
  INSTRUCTION_FILES,
  loadVaultInstructions,
  MAX_INSTRUCTIONS_CHARS,
} from "../src/agent/instructions";

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

  it("skips a file that fails to read instead of throwing (graceful fallback)", async () => {
    const adapter = {
      exists: async () => true,
      read: async () => {
        throw new Error("EACCES");
      },
    } as unknown as DataAdapter;
    expect(await loadVaultInstructions(adapter)).toBe("");
  });

  it("falls back to the next file when an earlier one fails to read", async () => {
    const adapter = {
      exists: async (p: string) => p === "AGENTS.md" || p === "CLAUDE.md",
      read: async (p: string) => {
        if (p === "AGENTS.md") throw new Error("broken symlink");
        return "claude-content";
      },
    } as unknown as DataAdapter;
    expect(await loadVaultInstructions(adapter)).toBe("claude-content");
  });

  it("truncates a file larger than the cap and appends a notice", async () => {
    const big = "x".repeat(MAX_INSTRUCTIONS_CHARS + 5000);
    const result = await loadVaultInstructions(fakeAdapter({ "AGENTS.md": big }));
    expect(result.length).toBeLessThan(big.length);
    expect(result.startsWith("x".repeat(100))).toBe(true);
    expect(result).toContain("truncated");
  });

  it("loads a file at exactly the cap without truncation", async () => {
    const exact = "y".repeat(MAX_INSTRUCTIONS_CHARS);
    expect(await loadVaultInstructions(fakeAdapter({ "AGENTS.md": exact }))).toBe(exact);
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

  it("bounds the injected content with an end marker so it can't run into later overlays", () => {
    const overlay = formatInstructionsOverlay("# My vault\n- be terse");
    expect(overlay).toContain("<!-- end of standing-instructions file -->");
    expect(overlay.endsWith("<!-- end of standing-instructions file -->")).toBe(true);
  });
});
