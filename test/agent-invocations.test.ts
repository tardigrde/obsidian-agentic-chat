import { describe, expect, it } from "vitest";
import {
  buildInitInvocation,
  buildInstructionCaptureInvocation,
  buildSubagentInvocation,
  unknownAgentMessage,
} from "../src/agent/agent-invocations";

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
    expect(directive).toContain("Request at most one mutation");
    expect(directive).toContain("If that edit or write is denied, do not retry");
  });

  it("builds the inline instruction capture directive with exact instruction text", () => {
    const directive = buildInstructionCaptureInvocation("Prefer concise vault updates.");

    expect(directive).toContain("Persist this user-provided standing instruction");
    expect(directive).toContain("AGENTS.md");
    expect(directive).toContain("Use the `edit` tool");
    expect(directive).toContain("<instruction>\nPrefer concise vault updates.\n</instruction>");
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
