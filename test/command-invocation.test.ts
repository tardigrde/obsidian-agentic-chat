import type { Skill } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { AgentCommandInvocationRuntime } from "../src/agent/command-invocation";
import type { AgentProfile } from "../src/agent/subagents";

function makeRuntime(resources: { skills?: Skill[]; profiles?: AgentProfile[] } = {}): {
  runtime: AgentCommandInvocationRuntime;
  prompts: string[];
  errors: string[];
} {
  const prompts: string[] = [];
  const errors: string[] = [];
  return {
    prompts,
    errors,
    runtime: new AgentCommandInvocationRuntime({
      getResources: () => ({
        skills: resources.skills ?? [],
        profiles: resources.profiles ?? [],
      }),
      runPrompt: async (prompt) => {
        prompts.push(prompt);
      },
      setError: (message) => errors.push(message),
    }),
  };
}

describe("AgentCommandInvocationRuntime", () => {
  it("runs skill command plans as prompts", async () => {
    const skill = {
      name: "daily",
      description: "Daily review",
      content: "Review $ARGUMENTS",
      filePath: "skills/daily/SKILL.md",
    } as unknown as Skill;
    const { runtime, prompts, errors } = makeRuntime({ skills: [skill] });

    await runtime.invokeSkill("daily", "today");

    expect(errors).toEqual([]);
    expect(prompts[0]).toContain("Review today");
  });

  it("surfaces command resolution errors without prompting", async () => {
    const { runtime, prompts, errors } = makeRuntime();

    await runtime.invokeSkill("missing");
    await runtime.invokeInstruction("   ");

    expect(prompts).toEqual([]);
    expect(errors).toEqual(['No skill named "missing".', "Add instruction text after #."]);
  });

  it("runs named subagent, init, and instruction commands through the prompt runner", async () => {
    const profile: AgentProfile = {
      name: "reviewer",
      description: "Review work",
      systemPrompt: "Review carefully.",
      toolAllowlist: [],
    };
    const { runtime, prompts, errors } = makeRuntime({ profiles: [profile] });

    await runtime.invokeAgent("reviewer", "check the diff");
    await runtime.invokeInit("focus on onboarding");
    await runtime.invokeInstruction("Prefer concise updates.");

    expect(errors).toEqual([]);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain("reviewer");
    expect(prompts[0]).toContain("check the diff");
    expect(prompts[1]).toContain("AGENTS.md");
    expect(prompts[1]).toContain("focus on onboarding");
    expect(prompts[2]).toContain("Prefer concise updates.");
  });
});
