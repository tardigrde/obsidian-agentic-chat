# Daily usage

Open Agentic Chat from the ribbon icon or the **Agentic Chat: Open chat** command.

## Send prompts

Type a message and press Enter. Use Shift+Enter for a newline.

The agent is told which note is active, any text you selected in it, and which other notes are open. It gets paths only, not the note text: it reads what it needs with line ranges or a search, so a very long note does not cost you tokens on every turn. Ignored notes and root standing-instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) are never named. Attach the whole text yourself when you want it in context:

- `@note`
- `@note#heading`
- `@note^block-id`
- the folder button in the composer
- drag and drop from the file explorer
- Obsidian context menus for notes, folders, or selected editor text

## Watch tool calls

Tool calls render inline in the transcript. You can expand them to inspect arguments, results, and timing.

Mutating calls follow the approval policy. When a call is set to **ask**, an approval card appears in the chat, below the turn's activity line. It shows the change as a line-level diff (red removed, green added) and three choices: **Allow**, **Always allow** the tool, and **Deny** (with an optional reason). Enter allows; Esc starts the deny. If the approval is in another tab, that tab gets an orange dot and the card waits there. Stop resolves a waiting card as stopped.

## Safe and YOLO modes

**Safe** follows your configured approval settings.

**YOLO** auto-approves most mutating tools until you switch back. Recursive folder deletes still ask, and a per-tool deny still wins.

## Switch models

Click the model pill in the composer or run `/model`. Shift-click (or Shift+Enter) in the picker applies a model to the next prompt only, shown with a "next only" badge. See [Choosing a model](./models.md).

## Sessions and long chats

Each chat is a session, saved as JSONL in the plugin folder and resumed on reload. Tabs sit in the header row at the top, up to five. A tab shows its number until you name it: double-click it (long-press on a phone), or use **Rename current tab** in the tab menu. The tab name is separate from the session name in history. Tabs that do not fit go into the `+N` menu. `/new` starts a new conversation in the current tab; `/sessions` browses, searches, reopens, renames, and deletes sessions.

Long sessions compact older turns automatically before the context window fills. Run `/compact [instructions]` to summarize now; the optional text tells the summary what to keep. `/usage` shows tokens and cost.


## Real-time controls

The composer has one delivery path:

- Enter while the agent is idle sends the text as a new turn.
- Enter while the agent responds steers the active turn. The text arrives after
  the current model turn finishes. If the run ends first (Stop, loop guard,
  spend cap), the text comes back to the composer so you can send it again.
- Shift+Enter inserts a newline in the draft.
- **Queue** holds the draft until the active turn ends. You can keep editing the
  draft while it waits.
- **Stop** ends the turn. Send the draft after Stop to replace the turn with a
  new prompt.

## Export conversations

Run `/export` to save the current conversation as a Markdown note in the vault.

## Reasoning effort

Set your reasoning effort with `/effort [level]` (for example, `/effort high`). The choice persists across messages. Change it with `/effort` again or click the effort value in the model pill (Alt+click on the pill also cycles it).

## Undo and retry

Use `/undo` to revert the last vault mutation made by the agent.

Every assistant answer has copy and retry actions. Click a sent message to rewind to that prompt, edit it, and regenerate from that point.
