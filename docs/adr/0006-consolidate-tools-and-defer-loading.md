# 0006 — Consolidate tools and defer rarely used ones

- Status: Accepted
- Date: 2026-11-16
- Supersedes: [0002 — Do not merge granular tools](0002-do-not-merge-tools.md)

## Decision

Before 1.0.0, when tool names become part of the contract:

- Merge the read-only skill tools into one `skill` tool (`action`: `read`,
  `read_file`). Remove `load_skill` and `unload_skill`.
- Merge the four artifact tools into one `artifact` tool (`action`: `list`,
  `search`, `read`, `export`).
- Delete the standalone inspect tools (`ls`, `search`, `find`, `grep`,
  `get_active_note`, `get_backlinks`, `get_links`, `local_graph`,
  `get_properties`). `vault_inspect` already covers them.
- Delete the tool budget. Defer rarely used tools instead: every MCP tool,
  `create_skill`, `import_document`, and `current_time`. The system prompt lists
  them; `search_tools` loads matches by their real names from the next step.
- Put today's date (no time) in the system prompt. `current_time` gives the time.

## Why

- 0002 rejected merges because one name cannot carry two approval policies.
  The merged tools are read-only in every action, so each still has one policy.
  Every mutating tool keeps its own name and its own allow/ask/deny entry.
- 0002 also said action enums turn schema errors into runtime errors. Both
  merged tools declare `action` as a JSON-schema `enum`, so a wrong action fails
  argument validation before execution, the same as any other bad argument.
- `load_skill`/`unload_skill` duplicated `read_skill`: the body reaches the
  model either way. Their persistent prompt overlay needed its own approval
  special case. Removing them removes that case.
- The tool budget dropped web, MCP, and subagent tools silently at 2% of the
  window, and an unknown model defaulted to 128k. Deferred loading keeps every
  tool reachable and keeps the per-request tool list small (14 core tools,
  down from 20).
- `search_tools` returns real tools, not a generic `call_tool(name, args)`, so
  approval, audit, and undo work on the real tool name. Anthropic, OpenAI,
  Claude Code, and Codex use the same "search, then call by name" pattern.
- The model had no clock. A prompt about "today" made it search the vault for
  the date (5-32 extra tool calls in the `find.easy.dentist` eval).

## Consequences

- Per-tool approval entries for removed names have no effect. This is not a
  less safe posture: the UI showed rows only for vault and MCP tools, and
  approval memory never saved `allow` for the skill tools. Only a hand-edited
  `deny` on an artifact tool becomes `allow` (all artifact actions are
  read-only).
- `toolBudget` in an old `data.json` is dropped on load (retired key).
- Old sessions that called the removed tools still open; their steps render
  with the stored name.
- A reopened session restores its loaded deferred tools from the transcript, so
  the JSONL format does not change.
- The deferred list in the system prompt does not change when a tool loads, so
  a load does not break the prompt cache. Each load changes the tool list once.
- Subagents get no `search_tools` and no MCP tools (unchanged).
