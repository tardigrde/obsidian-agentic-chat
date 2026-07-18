import { describe, expect, it } from "vitest";
import type { Skill } from "@earendil-works/pi-agent-core";
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "../src/agent/system-prompt";
import { MODES } from "../src/agent/modes";
import { OUTPUT_STYLES } from "../src/agent/output-styles";

const skill: Skill = { name: "Demo", description: "demo skill", content: "body", filePath: "Skills/demo.md" };

describe("buildSystemPrompt", () => {
  it("falls back to the default prompt and adds nothing for blank overlays/no skills", () => {
    expect(buildSystemPrompt("", [])).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(buildSystemPrompt("Base.", [], ["", "  "])).toBe("Base.");
  });

  it("bakes self-awareness and context-guardrail guidance into the default prompt", () => {
    // Self-awareness: the agent knows it is the agentic-chat Obsidian plugin.
    expect(DEFAULT_SYSTEM_PROMPT).toContain("agentic-chat");
    // Pointer to on-demand self-knowledge skill and read_skill tool.
    expect(DEFAULT_SYSTEM_PROMPT).toContain("self-knowledge");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("read_skill");
    // Attachments can be path-only references; the model must read them rather than assume.
    expect(DEFAULT_SYSTEM_PROMPT).toContain("path-only reference");
    // Don't re-read what's already in context; paginate large reads.
    expect(DEFAULT_SYSTEM_PROMPT).toContain("offset/limit");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("startLine/endLine");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("focused question");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("token usage and context bloat");
    // Ignore-listed (private) paths are off-limits.
    expect(DEFAULT_SYSTEM_PROMPT).toContain("ignore-listed");
  });

  it("appends non-blank overlays after the base prompt", () => {
    const out = buildSystemPrompt("Base.", [], [MODES.plan.promptOverlay, OUTPUT_STYLES.learning.promptOverlay]);
    expect(out.startsWith("Base.")).toBe(true);
    expect(out).toContain(MODES.plan.promptOverlay);
    expect(out).toContain(OUTPUT_STYLES.learning.promptOverlay);
  });

  it("keeps the skill listing last so overlays precede the model-visible skill block", () => {
    const out = buildSystemPrompt("Base.", [skill], [MODES.plan.promptOverlay]);
    expect(out.indexOf(MODES.plan.promptOverlay)).toBeLessThan(out.indexOf("Demo"));
  });
});
