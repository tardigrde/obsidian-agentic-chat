# Slash Commands

Slash commands run locally and are not sent to the model.

| Command | What it does |
| --- | --- |
| `/new` | Start a new conversation. |
| `/sessions` | Browse, search, reopen, rename, or delete past conversations. |
| `/history` | Alias for `/sessions`. |
| `/model` | Switch model. Shift actions apply a next-prompt-only override where supported. |
| `/config` | Switch permission mode. |
| `/mode` | Alias for `/config`. |
| `/add-dir [folder]` | Grant a vault working directory. On desktop, an absolute folder outside the vault configures the external workspace root instead. Without an argument, opens a vault folder picker. |
| `/dirs` | List or revoke granted working directories and the configured external workspace root. |
| `/plan` | Enter sticky read-only planning mode. |
| `/endplan` | Leave planning mode and restore the prior posture. |
| `/compact [instructions]` | Summarize older turns now. Optional instructions are passed to the compaction request. |
| `/init [instructions]` | Create or curate the vault standing-instructions file. Optional text guides that update. |
| `/style [name]` | Switch output style. |
| `/skill [name] [args]` | Run a vault skill. |
| `/<skill-name>` | Run a skill directly when no built-in command has that name. |
| `/agent [name] [task]` | Delegate a task to a subagent. Without arguments, opens a picker. |
| `/undo` | Undo the last vault change made by the agent. |
| `/status` | Show provider, model, mode, output style, session, MCP servers, and tools. |
| `/usage` | Show token and cost totals. |
| `/help` | List available commands. |
