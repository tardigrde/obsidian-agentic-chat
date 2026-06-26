import { describe, expect, it } from "vitest";
import { buildInitInvocation, buildSubagentInvocation, unknownAgentMessage } from "../src/agent/agent-invocations";

describe("agent invocation helpers", () => {
  it("builds the subagent delegation directive", () => {
    expect(buildSubagentInvocation("researcher", "summarize the inbox")).toBe(
      'Use the subagent tool to delegate this task to the "researcher" subagent: summarize the inbox',
    );
  });

  it("builds the init directive with standing-instructions targets and edit guidance", () => {
    const directive = buildInitInvocation();

    expect(directive).toContain("AGENTS.md");
    expect(directive).toContain("CLAUDE.md");
    expect(directive).toContain("GEMINI.md");
    expect(directive).toContain("Make surgical edits");
    expect(directive).toContain("use `write` only to create the file");
  });

  it("lists available subagents and hints similarly named skills", () => {
    expect(
      unknownAgentMessage(
        "deep",
        [{ name: "researcher" }, { name: "reviewer" }],
        [{ name: "deep-research" }],
      ),
    ).toBe(
      'No subagent named "deep". Did you mean the skill "deep-research"? Run it with /deep-research or /skill deep-research. Available subagents: researcher, reviewer.',
    );
  });

  it("reports when no subagents are configured", () => {
    expect(unknownAgentMessage("writer", [], [])).toBe(
      'No subagent named "writer". No subagents are configured.',
    );
  });
});
