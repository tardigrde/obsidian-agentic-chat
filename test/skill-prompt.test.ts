import { describe, expect, it } from "vitest";
import {
  escapeXml,
  formatSkillInvocation,
  formatSkillsForSystemPrompt,
  type Skill,
} from "../src/skills/skill-prompt";
import { parseCommandArgs, substituteArgs } from "../src/skills/command-args";

/**
 * These renderers and the command-argument parser used to be exported by
 * `pi-agent-core`'s experimental harness, which pi 1.0.0 removed. The plugin
 * now owns them, so these tests pin the Agent Skills wire format that the
 * model sees (https://agentskills.io/specification) rather than an internal
 * implementation detail.
 */

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "summarize",
    description: "Summarize a note.",
    content: "Do the summarizing.",
    filePath: "skills/summarize/SKILL.md",
    ...overrides,
  };
}

describe("formatSkillsForSystemPrompt", () => {
  it("renders an agentskills.io-compatible listing block", () => {
    const out = formatSkillsForSystemPrompt([skill()]);

    expect(out).toContain("<available_skills>");
    expect(out).toContain("<name>summarize</name>");
    expect(out).toContain("<description>Summarize a note.</description>");
    expect(out).toContain("<location>skills/summarize/SKILL.md</location>");
    expect(out.endsWith("</available_skills>")).toBe(true);
  });

  it("returns an empty string when there is nothing model-visible", () => {
    expect(formatSkillsForSystemPrompt([])).toBe("");
    // Explicitly-invoked-only skills stay out of the model's listing.
    expect(formatSkillsForSystemPrompt([skill({ disableModelInvocation: true })])).toBe("");
  });

  it("lists every model-visible skill", () => {
    const out = formatSkillsForSystemPrompt([skill(), skill({ name: "rewrite", filePath: "skills/rewrite/SKILL.md" })]);
    expect(out).toContain("<name>summarize</name>");
    expect(out).toContain("<name>rewrite</name>");
  });

  it("escapes XML metacharacters in name, description, and location", () => {
    const out = formatSkillsForSystemPrompt([
      skill({ name: "a&b", description: '<script>"x" & \'y\'</script>', filePath: "a<b>&c/SKILL.md" }),
    ]);

    expect(out).toContain("<name>a&amp;b</name>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    expect(out).toContain("&quot;x&quot;");
    expect(out).toContain("&apos;y&apos;");
    expect(out).toContain("a&lt;b&gt;&amp;c/SKILL.md");
  });
});

describe("escapeXml", () => {
  it("escapes the five predefined entities, ampersand first", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });
});

describe("formatSkillInvocation", () => {
  it("wraps the skill body and states the reference base directory", () => {
    const out = formatSkillInvocation(skill({ content: "STEP 1" }));

    expect(out).toContain('<skill name="summarize" location="skills/summarize/SKILL.md">');
    expect(out).toContain("References are relative to skills/summarize.");
    expect(out).toContain("STEP 1");
    expect(out.endsWith("</skill>")).toBe(true);
  });

  it("appends additional instructions after the skill block", () => {
    const out = formatSkillInvocation(skill(), "Only the executive summary.");

    expect(out.endsWith("Only the executive summary.")).toBe(true);
    expect(out.indexOf("</skill>")).toBeLessThan(out.indexOf("Only the executive summary."));
  });

  it("handles trailing slashes and Windows-style separators in the reference base", () => {
    expect(formatSkillInvocation(skill({ filePath: "skills/summarize/SKILL.md/" }))).toContain(
      "References are relative to skills/summarize.",
    );
    expect(formatSkillInvocation(skill({ filePath: "C:\\skills\\summarize\\SKILL.md" }))).toContain(
      "References are relative to C:\\skills\\summarize.",
    );
  });
});

describe("parseCommandArgs", () => {
  it("splits on whitespace", () => {
    expect(parseCommandArgs("one two   three")).toEqual(["one", "two", "three"]);
  });

  it("keeps quoted values together and strips the quotes", () => {
    expect(parseCommandArgs('one "two three" four')).toEqual(["one", "two three", "four"]);
    expect(parseCommandArgs("one 'two three'")).toEqual(["one", "two three"]);
  });

  it("returns no arguments for empty or whitespace-only input", () => {
    expect(parseCommandArgs("")).toEqual([]);
    expect(parseCommandArgs("   ")).toEqual([]);
  });
});

describe("substituteArgs", () => {
  it("substitutes 1-based positional arguments", () => {
    expect(substituteArgs("Hello $1 and $2", ["Ada", "Lovelace"])).toBe("Hello Ada and Lovelace");
  });

  it("substitutes every argument for $@ and $ARGUMENTS", () => {
    expect(substituteArgs("Args: $@", ["a", "b"])).toBe("Args: a b");
    expect(substituteArgs("Args: $ARGUMENTS", ["a", "b"])).toBe("Args: a b");
  });

  it("supports the ${@:N} slice form with and without a length", () => {
    expect(substituteArgs("${@:2}", ["a", "b", "c"])).toBe("b c");
    expect(substituteArgs("${@:1:2}", ["a", "b", "c"])).toBe("a b");
  });

  it("collapses out-of-range positions to an empty string", () => {
    expect(substituteArgs("$1-$9", ["only"])).toBe("only-");
  });
});