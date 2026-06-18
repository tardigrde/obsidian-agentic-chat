import { describe, expect, it } from "vitest";
import { appendMemory, formatMemoryOverlay } from "../src/agent/memory";

describe("appendMemory", () => {
  it("adds a bullet to an empty store", () => {
    expect(appendMemory("", "likes terse answers")).toBe("- likes terse answers");
  });

  it("appends a new fact below existing ones", () => {
    expect(appendMemory("- one\n- two", "three")).toBe("- one\n- two\n- three");
  });

  it("keeps an existing list marker verbatim", () => {
    expect(appendMemory("", "- already a bullet")).toBe("- already a bullet");
    expect(appendMemory("", "1. numbered too")).toBe("1. numbered too");
  });

  it("ignores a blank fact", () => {
    expect(appendMemory("- kept", "   ")).toBe("- kept");
    expect(appendMemory("", "\t")).toBe("");
  });

  it("trims trailing whitespace from the base before joining", () => {
    expect(appendMemory("- kept\n\n  ", "next")).toBe("- kept\n- next");
  });
});

describe("formatMemoryOverlay", () => {
  it("produces no overlay for blank memory", () => {
    expect(formatMemoryOverlay("")).toBe("");
    expect(formatMemoryOverlay("   \n ")).toBe("");
  });

  it("wraps memory in a heading and standing-context note", () => {
    const overlay = formatMemoryOverlay("- prefers concise answers");
    expect(overlay.startsWith("## Memory")).toBe(true);
    expect(overlay).toContain("standing context");
    expect(overlay).toContain("- prefers concise answers");
  });
});
