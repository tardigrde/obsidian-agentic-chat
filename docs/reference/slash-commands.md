# Slash Commands

Slash commands run locally and are not sent to the model.

| Command | What it does |
| --- | --- |
| `/new` | Start a new conversation. |
| `/sessions [clear --confirm]` | Browse, search, reopen, rename, or delete past conversations. Clear with confirmation deletes all conversations in the current scope. |
| `/history` | Alias for `/sessions`. |
| `/model` | Switch model. Shift actions apply a next-prompt-only override where supported. |
| `/effort [level]` | Set reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). The level persists across messages. Alias: `/thinking`. |
| `/config` | Switch permission mode. |
| `/mode` | Alias for `/config`. |
| `/add-dir [folder]` | Grant a vault working directory. Without an argument, opens a vault folder picker. Aliases: `/adddir`. |
| `/dirs` | List or revoke granted working directories. Alias: `/working-dirs`. |
| `/plan` | Enter sticky read-only planning mode. Leave by clicking the **Plan** badge or running `/config`. |
| `/compact [instructions]` | Summarize older turns now. Optional instructions are passed to the compaction request. |
| `/init [instructions]` | Create or update the vault standing-instructions file (`AGENTS.md`, falling back to `CLAUDE.md` / `GEMINI.md` at the vault root). Optional text guides the update. |
| `/style [name]` | Switch output style. |
| `/skill [name] [args]` | Run a vault skill. |
| `/<skill-name>` | Run a skill directly when no built-in command has that name. |
| `/agent [name] [task]` | Delegate a task to a subagent. Without arguments, opens a picker. |
| `/undo` | Undo the last vault change made by the agent. |
| `/status` | Show provider, model, mode, output style, session, MCP servers, and tools. |
| `/usage` | Show token and cost totals. |
| `/memory [add\|review\|manage\|export\|clear]` | Add, review, export, or clear stored long-term memories. |
| `/semantic-index [status\|estimate\|start\|cancel]` | Manage scoped semantic indexing. Alias: `/semindex`. |
| `/todo [add\|set\|test\|commit\|note\|title]` | Track milestones, tests, checkpoint commits, notes (`/todo note <id> <note>`), and the plan title (`/todo title <name>`). Alias: `/todos`. |
| `/steer [text]` | Steer the active turn while the agent is responding. |
| `/follow-up [text]` | Queue a follow-up behind the active turn. Alias: `/followup`. |
| `/redirect [text]` | Stop the active turn and answer this instead. |
| `/export` | Save this conversation as a Markdown note in the vault. |
| `/doctor` | Audit runtime health, agent plugins, and MCP configs. |
| `/help` | List available commands. |

`/project` was retired with project workspaces; typing it shows a hint to use `/add-dir` and `/style` instead.
