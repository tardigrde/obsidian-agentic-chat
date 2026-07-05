import type { Skill } from "@earendil-works/pi-agent-core";
import type { AgentProfile } from "./subagents";

export function buildSubagentInvocation(name: string, task: string): string {
  return `Use the subagent tool to delegate this task to the "${name}" subagent: ${task}`;
}

export function buildInitInvocation(instructions?: string): string {
  const parts = [
    "Curate this vault's standing-instructions file for the agentic-chat agent.",
    "Target the first of AGENTS.md, CLAUDE.md, or GEMINI.md that exists at the vault root; if none exists, create AGENTS.md.",
    "First read the current file (if any) and survey the vault structure (top-level folders and a few representative notes) to infer what this vault is for.",
    "Then write concise, durable guidance an agent needs to work well here: the vault's purpose, key folders, conventions, and the user's preferences.",
    "Make surgical edits with the `edit` tool — change only what is stale or missing, preserving existing good content; use `write` only to create the file.",
    "Request at most one mutation. If that edit or write is denied, do not retry the same change and do not ask the user for broader permission; report that the update was declined.",
    "Keep it concise: this file is injected into every conversation.",
    "Describe folder and note paths relative to the vault root, and do not suggest recreating the vault's own name as a nested folder inside the vault.",
    "Keep citation guidance self-consistent: if you mention the external workspace, cite external files as relative `external://path` references and never as absolute filesystem paths.",
  ];
  const trimmed = instructions?.trim();
  if (trimmed) parts.push("Additional user instructions for this initialization:", `<instructions>\n${trimmed}\n</instructions>`);
  return parts.join(" ");
}

export function buildInstructionCaptureInvocation(instruction: string): string {
  return [
    "Persist this user-provided standing instruction for future agentic-chat turns.",
    "Target the first of AGENTS.md, CLAUDE.md, or GEMINI.md that exists at the vault root; if none exists, create AGENTS.md.",
    "First read the current file if it exists.",
    "Add the instruction exactly once, preserving existing good content and avoiding duplicates.",
    "Use the `edit` tool for surgical changes; use `write` only to create AGENTS.md when no standing-instructions file exists.",
    "Keep the file concise because it is injected into every conversation.",
    "Instruction to persist:",
    "<instruction>",
    instruction.trim(),
    "</instruction>",
  ].join("\n");
}

export function unknownAgentMessage(
  name: string,
  profiles: Pick<AgentProfile, "name">[],
  skills: Pick<Skill, "name">[],
): string {
  const available = profiles.map((item) => item.name);
  const lower = name.toLowerCase();
  const skill = skills.find(
    (item) => item.name.toLowerCase() === lower || item.name.toLowerCase().includes(lower),
  );
  const parts = [`No subagent named "${name}".`];
  if (skill) parts.push(`Did you mean the skill "${skill.name}"? Run it with /${skill.name} or /skill ${skill.name}.`);
  parts.push(available.length > 0 ? `Available subagents: ${available.join(", ")}.` : "No subagents are configured.");
  return parts.join(" ");
}
