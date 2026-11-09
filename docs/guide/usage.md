# Daily usage

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

Mutating calls follow the approval policy. When a call is set to **ask**, the plugin shows the pending arguments and a line-level diff (red removed, green added) before anything changes.

## Safe and YOLO modes

**Safe** follows your configured approval settings.

**YOLO** auto-approves most mutating tools until you switch back. Recursive folder deletes still ask, and a per-tool deny still wins.

Run `/compact [instructions]` to summarize older turns on demand. The optional instructions are passed to the compaction request, so important details survive the summary.

## Memory

Add long-term memories with `/memory add [kind] [scope] <text>`. Kinds are `preference`, `fact`, `instruction`, or `summary`. Scopes are `global` or `vault`.

Review stored memories with `/memory review`. Export them with `/memory export`. Clear everything with `/memory clear --confirm`.

The agent retrieves memories explicitly through the `search_memory` tool. The plugin never injects them automatically.

## Semantic indexing

Run `/semantic-index start` to build a vector index over your current scope (vault, folder, tag, or the active note's folder). A full-vault build requires `/semantic-index start vault --confirm-vault`. Check status with `/semantic-index status` and estimate cost with `/semantic-index estimate`.

Cancel an in-progress build with `/semantic-index cancel`.

## Real-time controls

The composer has one delivery path:

- Enter while the agent is idle sends the text as a new turn.
- Enter while the agent responds steers the active turn. The text arrives after
  the current model turn finishes. If the run ends first (Stop, turn cap, loop
  guard), the text comes back to the composer so you can send it again.
- Shift+Enter inserts a newline in the draft.
- **Queue** holds the draft until the active turn ends. You can keep editing the
  draft while it waits.
- **Stop** ends the turn. Send the draft after Stop to replace the turn with a
  new prompt.

## Export conversations

Run `/export` to save the current conversation as a Markdown note in the vault.

## Reasoning effort

Set your reasoning effort with `/effort [level]` (for example, `/effort high`). The choice persists across messages. Change it with `/effort` again or with the effort knob in the composer.

## Undo and retry

Use `/undo` to revert the last vault mutation made by the agent.

Every assistant answer has copy and retry actions. Click a sent message to rewind to that prompt, edit it, and regenerate from that point.
