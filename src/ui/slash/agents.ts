import type { SlashContext } from "./context";

/** Run a skill by name: render a loaded-signal, then invoke it as a prompt. */
export async function runSkill(
  ctx: SlashContext,
  name: string | undefined,
  extra: string,
  display?: string,
): Promise<void> {
  if (!name) {
    showSkillList(ctx);
    return;
  }
  ctx.clearEmptyState();
  const extraPart = extra ? ` ${extra}` : "";
  ctx.renderOutgoingUserMessage(display ?? `/skill ${name}${extraPart}`, []);
  const skill = ctx.service.getSkills().find((item) => item.name.toLowerCase() === name.toLowerCase());
  // Visible success signal: /skill otherwise injects silently and the
  // transcript jumps straight to the first thought/tool step.
  if (skill) ctx.renderInfoMessage("Skill", [[skill.name, skill.description]]);
  await ctx.service.invokeSkill(name, extra || undefined);
  ctx.showServiceError();
}

/** `/skill` with no argument: a clickable picker, not a static list. */
export function showSkillList(ctx: SlashContext): void {
  const skills = ctx.service.getSkills();
  ctx.clearEmptyState();
  if (skills.length === 0) {
    ctx.renderInfoMessage("Skills", [["(none)", "Set a skills folder in settings to add skills."]]);
    return;
  }
  ctx.renderActionList(
    "Skills",
    "Pick a skill to run.",
    skills.map((skill) => ({
      label: skill.name,
      detail: skill.description,
      icon: "sparkles",
      onClick: () => void runSkill(ctx, skill.name, ""),
    })),
  );
}

export async function runAgent(ctx: SlashContext, name: string | undefined, task: string): Promise<void> {
  if (!name) {
    showAgentList(ctx);
    return;
  }
  ctx.clearEmptyState();
  const taskPart = task ? ` ${task}` : "";
  ctx.renderOutgoingUserMessage(`/agent ${name}${taskPart}`, []);
  await ctx.service.invokeAgent(name, task);
  ctx.showServiceError();
}

/** `/agent` with no argument: a clickable picker that prefills the composer. */
export function showAgentList(ctx: SlashContext): void {
  const profiles = ctx.service.getProfiles();
  ctx.clearEmptyState();
  if (profiles.length === 0) {
    ctx.renderInfoMessage("Subagents", [
      ["(none)", "Enable built-in subagents or set a subagents folder in settings."],
    ]);
    return;
  }
  ctx.renderActionList(
    "Subagents",
    "Pick a subagent, then type its task.",
    profiles.map((profile) => ({
      label: profile.name,
      detail: profile.description,
      icon: "bot",
      onClick: () => prefillComposer(ctx, `/agent ${profile.name} `),
    })),
  );
}

function prefillComposer(ctx: SlashContext, text: string): void {
  // setComposerValue dispatches the "input" event so autocomplete/composer
  // state stays in sync (a bare `.value =` would not).
  ctx.setComposerValue(text);
  ctx.inputEl.focus();
  ctx.inputEl.setSelectionRange(text.length, text.length);
}

/** `/init`: drive the agent to curate the vault's AGENTS.md standing-instructions file. */
export async function runInit(ctx: SlashContext, instructions = ""): Promise<void> {
  ctx.clearEmptyState();
  const initPart = instructions.trim() ? ` ${instructions.trim()}` : "";
  const display = `/init${initPart}`;
  ctx.renderOutgoingUserMessage(display, []);
  await ctx.service.invokeInit(instructions);
  ctx.showServiceError();
}
