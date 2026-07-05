import { describe, expect, it } from "vitest";
import type { Skill } from "@earendil-works/pi-agent-core";
import {
  type AgentCommandPlan,
  resolveAgentCommand,
  resolveInitCommand,
  resolveInstructionCommand,
  resolveSkillCommand,
} from "../src/agent/command-dispatcher";
import type { AgentProfile } from "../src/agent/subagents";

function skill(name: string, content = "Do the thing."): Skill {
  return { name, description: name, content, filePath: `Skills/${name}.md` };
}

function profile(name: string): AgentProfile {
  return {
    name,
    description: name,
    systemPrompt: `${name} prompt`,
    toolAllowlist: [],
  };
}

function expectPrompt(plan: AgentCommandPlan): string {
  expect(plan.type).toBe("prompt");
  return plan.type === "prompt" ? plan.prompt : "";
}

function expectError(plan: AgentCommandPlan): string {
  expect(plan.type).toBe("error");
  return plan.type === "error" ? plan.message : "";
}

describe("agent command plans", () => {
  it("resolves a named skill with argument substitution", () => {
    const plan = resolveSkillCommand(
      {
        skills: [skill("summarize", "Summarize $1 now.")],
      },
      "summarize",
      "Daily.md",
    );

    const prompt = expectPrompt(plan);
    expect(prompt).toContain('<skill name="summarize"');
    expect(prompt).toContain("Summarize Daily.md now.");
  });

  it("reports an unknown skill without prompting the agent", () => {
    expect(expectError(resolveSkillCommand({ skills: [] }, "missing"))).toBe('No skill named "missing".');
  });

  it("resolves a named subagent with the trimmed task", () => {
    const plan = resolveAgentCommand(
      {
        skills: [],
        profiles: [profile("researcher")],
      },
      "researcher",
      "  summarize the inbox  ",
    );

    expect(expectPrompt(plan)).toBe(
      'Use the subagent tool to delegate this task to the "researcher" subagent: summarize the inbox',
    );
  });

  it("reports an unknown subagent and hints matching skills", () => {
    const plan = resolveAgentCommand(
      {
        skills: [skill("deep-research")],
        profiles: [profile("researcher")],
      },
      "deep",
      "do research",
    );

    expect(expectError(plan)).toBe(
      'No subagent named "deep". Did you mean the skill "deep-research"? Run it with /deep-research or /skill deep-research. Available subagents: researcher.',
    );
  });

  it("requires a non-empty subagent task", () => {
    const plan = resolveAgentCommand(
      {
        skills: [],
        profiles: [profile("researcher")],
      },
      "researcher",
      "   ",
    );

    expect(expectError(plan)).toBe('Give the "researcher" subagent a task, e.g. /agent researcher <task>.');
  });

  it("resolves the init directive", () => {
    const prompt = expectPrompt(resolveInitCommand());

    expect(prompt).toContain("Curate this vault's standing-instructions file");
    expect(prompt).toContain("AGENTS.md");
  });

  it("includes user-provided init instructions in the directive", () => {
    const prompt = expectPrompt(resolveInitCommand(" focus on onboarding notes "));

    expect(prompt).toContain("Additional user instructions");
    expect(prompt).toContain("<instructions>\nfocus on onboarding notes\n</instructions>");
  });

  it("resolves an inline standing-instruction capture directive", () => {
    const prompt = expectPrompt(resolveInstructionCommand(" Prefer concise vault updates. "));

    expect(prompt).toContain("Persist this user-provided standing instruction");
    expect(prompt).toContain("<instruction>\nPrefer concise vault updates.\n</instruction>");
  });

  it("requires inline standing-instruction text", () => {
    expect(expectError(resolveInstructionCommand("   "))).toBe("Add instruction text after #.");
  });
});
