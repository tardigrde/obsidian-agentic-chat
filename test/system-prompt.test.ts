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
