# Agent workflows

Three ways to shape what the agent does beyond a single prompt: standing
instructions for every turn, skills for repeatable procedures, and subagents for
work that should not fill the main context.

## Standing instructions (AGENTS.md)

The agent loads one standing-instructions file from the vault root on every turn
and adds it to the system prompt. Use it for the vault's purpose, key folders,
conventions, and your preferences.

- **Which file.** `AGENTS.md` first, then `CLAUDE.md`, then `GEMINI.md`. Symlink
  them if several agents should share one file.
- **Keep it short.** It goes into every request. Content past 16,000 characters
  is truncated with a notice.
- **Let the agent curate it.** `/init [instructions]` reads the vault and the
  current file, then proposes small edits, each with a diff. `write` is used only
  to create the file. Edits use the normal approval gate and `/undo`.
- **Always included.** The file is implicit context whenever present, so it is
  never attached as an active-note chip.
- **Live.** Edit it mid-session; the next turn uses the new content.

A useful starting point:

```markdown
# Vault
Personal knowledge base. Daily notes in Journal/YYYY-MM-DD.md, projects in Projects/<name>/.

# Conventions
- Tags: #status/active, #status/done. Never invent new top-level tags.
- Link people as [[People/First Last]].

# Never
- Touch Archive/ or Templates/.
```

## Skills

Skills use the [agentskills.io](https://agentskills.io) `SKILL.md` format.

- **Where.** Each [agent plugin](./agent-plugins.md) in `.agentic-plugins/`
  provides `skills/<name>/SKILL.md`. Your own skills go in the `my-skills`
  package. Plugin skills load before built-ins and win a name collision.
- **Cheap until used.** The model sees only each skill's name and description
  until the skill is invoked.
- **Run.** `/skill <name> [args]`, or `/<name>` when no built-in command has
  that name. The agent can also invoke a skill on its own.
- **Arguments.** A body can use `$ARGUMENTS` or `$1`, `$2`, and so on.
- **Create.** *Advanced → Agent plugins → New skill…*, or ask the agent (it uses
  the `create_skill` tool, which always asks first).
- **Audit.** `/doctor` checks every package against the spec.

Example `my-skills/skills/weekly-review/SKILL.md`:

```markdown
---
name: weekly-review
description: Write a weekly review note from this week's daily notes.
---
Read Journal/ notes from the last 7 days. Write Reviews/$1.md with sections
Wins, Misses, Next week. Link every source note.
```

Run it with `/weekly-review 2026-W47`.

Built-in skills: `self-knowledge`, `install-plugin`, and `deep-research` (only
with web access on).

## Subagents

The agent can delegate a focused task to a child agent with its own context
window, the role's model (or the parent's), and only the tools in its allowlist.

- **Roles.** The only built-in role is **Explorer** (read-only recon). Custom
  roles need a code change.
- **Dispatch.** `/agent <name> <task>`, `/agent` for a picker, or the model
  calls `subagent` on its own. Several calls in one message run concurrently,
  with a cap. Children cannot spawn children.
- **Approval.** Each child tool call still passes through the parent's approval
  gate.
- **UI and cost.** A dispatch shows a step row in the activity line with each child's live status and a Stop per running child;
  click a row for its summary. Child tokens and cost add to the session total.
- **Timeout.** *Advanced → Subagents → Subagent timeout* aborts a child after N
  seconds (`0` disables).
- **Replay.** Child steps are live only. After you reopen a session, the summary
  remains but the child steps cannot be replayed.

When to use it: wide searches ("map every note about pricing") where you only
want the conclusion in the main chat.
