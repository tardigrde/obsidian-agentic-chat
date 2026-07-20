# Daily Usage

Open Agentic Chat from the ribbon icon or the **Agentic Chat: Open chat** command.

## Send prompts

Type a message and press Enter. Use Shift+Enter for a newline.

The active note is attached automatically unless it is ignored, is a root standing-instruction file (`AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`), or you dismissed the chip for the current session. Standing-instruction files are implicit context whenever present. Add more context with:

- `@note`
- `@note#heading`
- `@note^block-id`
- the folder button in the composer
- drag and drop from the file explorer
- Obsidian context menus for notes, folders, or selected editor text

## Watch tool calls

Tool calls render inline in the transcript. You can expand them to inspect arguments, results, and timing.

Mutating calls are controlled by the approval policy. When a call is set to **ask**, the plugin shows the pending arguments and a line-level diff before anything changes.

Diff previews color removed lines red and added lines green.

## Safe, YOLO, and plan modes

**Safe** honors your configured approval settings.

**YOLO** auto-approves mutating tools for the current session, except for tools explicitly set to deny.

`/plan` enters read-only planning mode. It blocks mutations until `/endplan` restores the previous posture.

Run `/compact [instructions]` to summarize older turns on demand. The optional instructions are passed to the compaction request so important details survive the summary.

## Project workspaces

Use `/project` to switch between scoped workspaces. Each project can have its own folders, model, style, and tool toggles. `/project clear` returns to vault-wide mode.

When a project is active, sessions and context are scoped to that project automatically.

## Memory

Add long-term memories with `/memory add [kind] [scope] <text>`. Kinds are `preference`, `fact`, `instruction`, or `summary`. Scopes are `global`, `vault`, or `project`.

Review stored memories with `/memory review`. Export them with `/memory export`. Clear everything with `/memory clear --confirm`.

The agent retrieves memories explicitly via the `search_memory` tool; they are never injected automatically.

## Semantic indexing

Run `/semantic-index start` to build a vector index over your current scope (vault, folder, tag, or project). Check status with `/semantic-index status` and estimate cost with `/semantic-index estimate`.

Cancel an in-progress build with `/semantic-index cancel`.

## Todo tracking

Use `/todo add <milestone>` to add a milestone. Update status with `/todo set <id> <pending|active|done|blocked>`. Track tests with `/todo test <id> <not-run|running|passed|failed|skipped>`. Attach checkpoint commits with `/todo commit <id> <commit>`.

The plan tracker panel shows live progress.

## Real-time controls

While the agent is streaming a response, you can:

- `/steer [text]` — steer the current turn mid-stream.
- `/follow-up [text]` — queue a follow-up message behind the active turn.
- `/redirect [text]` — stop the active turn and answer the new text instead.

## Export conversations

Run `/export` to save the current conversation as a Markdown note in the vault.

## Reasoning effort

Override the default thinking level for the next message with `/effort [level]` (e.g., `/effort high`). It resets after the next turn.

## Undo and retry

Use `/undo` to revert the last vault mutation made by the agent.

Every assistant answer has copy and retry actions. Click a sent message to rewind to that prompt, edit it, and regenerate from that point.
