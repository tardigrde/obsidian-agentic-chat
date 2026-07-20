import type { Skill } from "@earendil-works/pi-agent-core";
import { buildSkillInvocation } from "../skills/skills";
import {
  buildInitInvocation,
  buildInstructionCaptureInvocation,
  buildSubagentInvocation,
  unknownAgentMessage,
} from "./agent-invocations";
import type { AgentProfile } from "./subagents";

export interface AgentCommandResources {
  skills: Skill[];
  profiles: AgentProfile[];
}

export type AgentCommandPlan =
  | { type: "prompt"; prompt: string }
  | { type: "error"; message: string };

export function resolveSkillCommand(
  resources: Pick<AgentCommandResources, "skills">,
  name: string,
  args?: string,
): AgentCommandPlan {
  const skill = resources.skills.find((item) => item.name === name);
  if (!skill) return { type: "error", message: `No skill named "${name}".` };
  return { type: "prompt", prompt: buildSkillInvocation(skill, args) };
}

export function resolveAgentCommand(resources: AgentCommandResources, name: string, task: string): AgentCommandPlan {
  const hasProfile = resources.profiles.some((item) => item.name === name);
  if (!hasProfile) {
    return { type: "error", message: unknownAgentMessage(name, resources.profiles, resources.skills) };
  }
  const trimmed = task.trim();
  if (!trimmed) {
    return { type: "error", message: `Give the "${name}" subagent a task, e.g. /agent ${name} <task>.` };
  }
  return { type: "prompt", prompt: buildSubagentInvocation(name, trimmed) };
}

export function resolveInitCommand(instructions?: string): AgentCommandPlan {
  return { type: "prompt", prompt: buildInitInvocation(instructions) };
}

export function resolveInstructionCommand(instruction: string): AgentCommandPlan {
  const trimmed = instruction.trim();
  if (!trimmed) return { type: "error", message: "Add instruction text after #." };
  return { type: "prompt", prompt: buildInstructionCaptureInvocation(trimmed) };
}
