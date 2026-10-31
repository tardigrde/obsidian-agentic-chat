# Agent skills

This directory is a portable skill source. OpenCode reads `.agents/skills/`,
and so do Codex and other harnesses that follow the same convention.

## Local, hand-written

- `ship-change/`
- `verify-obsidian-chat/`
- `probe-feature/`

These are reviewed with the code in this repository. They are not listed in
`skills-lock.json`, because that file records skills installed from an external
source. Keep them when syncing or updating installed skills.

## Installed

`cavecrew` and the `caveman-*` skills are installed from
`JuliusBrussee/caveman` and tracked in `skills-lock.json`.
