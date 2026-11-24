# Agent skills

This directory is a portable skill source. OpenCode reads `.agents/skills/`,
Claude Code reads it through the `.claude/skills` symlink,
and so do Codex and other harnesses that follow the same convention.

All skills here are hand-written and reviewed with the code in this repository:

- `ship-change/`
- `factory/`
- `verify-pr/`
- `app/` (with the feature map in `app/features/` and explore charters in `app/charters/`)
- `worktree/`

Keep this list to the process skills in `AGENTS.md`. A personal skill belongs in
your own agent config, not in the repository: every skill description is loaded
into every agent's context.
