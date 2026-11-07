# Slash commands

Slash commands run locally and are not sent to the model.

| Command | What it does |
| --- | --- |
| `/new` | Start a new conversation. |
| `/sessions [clear --confirm]` | Browse, search, reopen, rename, or delete past conversations. Clear with confirmation deletes all conversations in the current scope. |
| `/model` | Switch model. Shift actions apply a next-prompt-only override where supported. |
| `/effort [level]` | Set reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). The level persists across messages. |
| `/add-dir [folder]` | Grant a vault working directory. Without an argument, opens a vault folder picker. |
| `/dirs` | List or revoke granted working directories. |
| `/plan` | Enter sticky read-only planning mode. Leave by clicking the **Plan** badge in chat. |
| `/compact [instructions]` | Summarize older turns now. Optional instructions are passed to the compaction request. |
| `/init [instructions]` | Create or update the vault standing-instructions file (`AGENTS.md`, falling back to `CLAUDE.md` or `GEMINI.md` at the vault root). Optional text guides the update. |
| `/style [name]` | Switch output style. |
| `/skill [name] [args]` | Run a vault skill. |
| `/<skill-name>` | Run a skill directly when no built-in command has that name. |
| `/agent [name] [task]` | Delegate a task to a subagent. Without arguments, opens a picker. |
| `/undo` | Undo the last vault change made by the agent. |
| `/status` | Show provider, model, mode, output style, session, MCP servers, and tools. |
| `/usage` | Show token and cost totals. |
| `/memory [add\|review\|manage\|export\|clear]` | Add, review, export, or clear stored long-term memories. |
| `/semantic-index [status\|estimate\|start\|cancel]` | Manage scoped semantic indexing. |
| `/export` | Save this conversation as a Markdown note in the vault. |
| `/doctor` | Audit runtime health, agent plugins, and MCP configs. |
| `/help` | List available commands. |

`/endplan` does not exist. Leave plan mode with the **Plan** badge in chat.

## Composer paths

These controls are not slash commands:

| Control | What it does |
| --- | --- |
| Enter while idle | Send the text as a new turn. |
| Enter while the agent responds | Steer the active turn. The text arrives after the next successful tool call. |
| Shift+Enter | Insert a newline in the draft. |
| **Queue** | Hold the draft until the active turn ends. The draft stays editable. |
| **Stop**, then send | Replace the turn with the draft. |
