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

## Undo and retry

Use `/undo` to revert the last vault mutation made by the agent.

Every assistant answer has copy and retry actions. Click a sent message to rewind to that prompt, edit it, and regenerate from that point.
