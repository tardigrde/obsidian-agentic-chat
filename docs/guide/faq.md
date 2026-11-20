# FAQ and glossary

## FAQ

### Is my vault uploaded somewhere?

No bulk upload. Only what the agent reads in a turn (attached notes, notes it
opens with tools, tool results) goes to your model provider for that request.
With Ollama, that stays on your machine. Web, MCP, and observability send data
only after you enable them. See [Privacy model](./privacy.md).

### Can the agent delete or wreck my notes?

Not silently. Every mutating tool asks by default and shows a diff. Deletes go to
the trash. If no trash works, the file is removed permanently and the result
says "bypassed trash". `/undo` reverts the last write, edit, rename, frontmatter change,
or single delete. Even in YOLO mode, recursive folder deletes still ask. A
recursive delete of a non-empty folder cannot be undone, so keep backups or
version control anyway.

### How do I keep it out of private notes?

Add globs to *Settings → Advanced → Ignored files*, for example `Private/`,
`*.secret.md`, or `**/diary/**`. Matching files report as "not found" to every
tool, so the agent cannot read, list, search, or edit them. They are never
auto-attached. Two exceptions: the standing-instructions file (`AGENTS.md`,
`CLAUDE.md`, or `GEMINI.md`) is sent every turn even if it matches, and an
image you attach yourself is sent.

### Can I use Claude, GPT, Gemini, or another model?

Yes, through OpenRouter (any tool-capable model in its catalog) or any
**OpenAI-compatible** endpoint you point the plugin at. Strict privacy routing
can hide models without a zero-retention endpoint; see
[Choosing a model](./models.md#privacy-and-model-choice).

### What does it cost?

The plugin is free. You pay your model provider per token. With the default
model, a typical vault task in the eval suite costs about $0.002. `/usage` shows
the running total; set a **Hard spend cap (USD)** to stop at a limit. See
[What a session costs](./models.md#what-a-session-costs).

### Does it work on mobile?

Yes, same features, with these limits: the plugin HTTP proxy fields are
desktop-only (use the device or VPN proxy instead), importing an agent plugin
from a vault folder is desktop-only, and MCP OAuth providers that only allow
localhost redirects need desktop sign-in.

### Where are my conversations stored?

As JSONL files in `.obsidian/plugins/agentic-chat/sessions/` inside your vault.
`/sessions` browses, renames, deletes, and clears them. `/export` saves one as a
Markdown note.

### Why didn't the agent see a file I just added?

If you created it outside Obsidian (for example a skill under a dot-folder), the
vault index may be stale. Restart Obsidian to re-index. See
[Troubleshoot](./troubleshoot.md#skills).

### Can I run local MCP servers (stdio)?

No. MCP uses Streamable HTTP: HTTPS for remote servers, plain HTTP only for
loopback. This keeps the plugin mobile-safe and unable to spawn processes. Run a
local server that speaks HTTP on `localhost` instead.

### The agent is going in circles. How do I stop it?

Press **Stop**. A turn also stops on its own after **Max turns per prompt**
(default 25), on the loop guard, or at the spend cap. To redirect without
stopping, type and press Enter while it works. That steers the run.

### Where do I report a bug?

[GitHub issues](https://github.com/tardigrde/obsidian-agentic-chat/issues).
Include the output of `/status` and `/doctor`.

## Glossary

| Term | Meaning |
| --- | --- |
| **Agent** | The model plus a loop: it can call tools, read the results, and continue until the task is done. |
| **Tool call / step** | One action the agent takes (`read`, `edit`, `rename`, …). Each turn has one activity line (`Read 4 notes, edited 1`); click it to see each step with its arguments, result, and timing. |
| **Approval gate** | The allow / ask / deny policy for mutating tools, set globally or per tool. **Deny** always wins. |
| **Safe / YOLO** | Composer switch. Safe follows your approval policy; YOLO auto-approves mutating tools for the session, except recursive folder deletes and `create_skill`. |
| **Steering** | Sending a message while the agent works. It arrives after the current model turn. |
| **Standing instructions** | `AGENTS.md` (or `CLAUDE.md` / `GEMINI.md`) at the vault root, added to every turn. |
| **Skill** | A `SKILL.md` file with reusable instructions. The model sees only its name and description until it is invoked with `/<name>` or by the agent. |
| **Agent plugin** | A folder in `.agentic-plugins/` that bundles skills and MCP servers ([Agent Plugins 1.0.0](https://agent-plugins.org) format). Not an Obsidian plugin. |
| **MCP** | Model Context Protocol. Lets the agent call tools on external servers. Tools appear as `mcp__<server>__<tool>`. |
| **Subagent / Explorer** | A child agent with its own context window. The built-in Explorer does read-only recon and reports a summary. |
| **Artifact** | A large tool output (MCP result, imported document) stored outside the chat. The agent reads slices with the `artifact` tool, which keeps context small. |
| **Deferred tool** | A tool listed in the prompt but loaded only when needed (`search_tools`): MCP tools, `import_document`, `create_skill`. |
| **Compaction** | Summarizing older turns before the context window fills (auto at 80%, or `/compact`). |
| **Context window** | How many tokens the model can see at once. The ring in the composer shows how full it is; hover it for the breakdown. |
| **Effort** | Reasoning effort (`off` … `xhigh`) for models that support it. More effort means more tokens. |
| **ZDR** | Zero data retention: an OpenRouter routing rule that sends requests only to endpoints that store nothing. On by default. |
