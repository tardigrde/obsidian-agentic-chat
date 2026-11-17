import { describe, expect, it } from "vitest";
import type { Skill } from "../src/skills/skill-prompt";
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT } from "../src/agent/system-prompt";
const OVERLAY = "Overlay: answer in short sentences.";

const skill: Skill = { name: "Demo", description: "demo skill", content: "body", filePath: "Skills/demo.md" };

describe("buildSystemPrompt", () => {
  it("falls back to the default prompt and adds nothing for blank overlays/no skills", () => {
    expect(buildSystemPrompt("", [])).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(buildSystemPrompt("Base.", [], ["", "  "])).toBe("Base.");
  });

  it("appends non-blank overlays after the base prompt", () => {
    const out = buildSystemPrompt("Base.", [], [OVERLAY]);
    expect(out.startsWith("Base.")).toBe(true);
    expect(out).toContain(OVERLAY);
  });

  it("keeps the skill listing last so overlays precede the model-visible skill block", () => {
    const out = buildSystemPrompt("Base.", [skill], [OVERLAY]);
    expect(out.indexOf(OVERLAY)).toBeLessThan(out.indexOf("Demo"));
  });
});
