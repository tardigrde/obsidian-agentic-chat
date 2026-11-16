# Vault tools

All tool paths are vault-relative. The plugin rejects absolute paths and `..` escapes.

Paths that match an ignore glob report as not found. The agent cannot read, list, search, or edit them.

## Read-only tools

| Tool | What it does |
| --- | --- |
| `read` | Read a note's contents, optionally bounded with `startLine` and `endLine`, or with byte `offset` and `limit`. |
| `vault_inspect` | Read-only meta-tool for vault context. Use `action=list` to list a folder, `action=search` to search file names and contents, `action=active_note` to read the active note, `action=local_graph` for a note's link neighborhood, or `action=properties` to read YAML frontmatter. |

Read-only tools run without approval. An explicit per-tool ask or deny still applies.

## Mutating tools

| Tool | What it does |
| --- | --- |
| `write` | Create or overwrite a note. |
| `edit` | Replace exact strings within a note. |
| `set_properties` | Write YAML frontmatter through Obsidian APIs. |
| `rename` | Rename or move a note and preserve inbound wikilinks and backlinks. |
| `delete` | Move a note or folder to trash. A non-empty folder needs `recursive:true`, which asks even in YOLO unless deletes are explicitly allowed per tool. Stale dot-folder paths use the adapter. If system and local trash are both unavailable, the plugin removes the file permanently. |

Mutating tools follow the approval policy. `/undo` reverts the latest undoable vault change, such as an edit, write, rename, single-file delete, or empty-folder delete. A recursive delete of a non-empty folder cannot be reverted.

## Other tools you will see as step cards

These tools are always loaded:

| Tool | What it does |
| --- | --- |
| `ask_user` | Inline clarification prompt. The answer steers the run. |
| `subagent` | Delegates recon to the read-only Explorer, one level deep. |
| `skill` | Read a skill. `action=read` returns its instructions; `action=read_file` reads a file inside the skill folder. Read-only. |
| `artifact` | Inspect large tool outputs kept out of context. `action=list`, `search`, `read`, or `export`. Read-only. |
| `web_search` / `fetch_url` | Opt-in web tools. See [Web, MCP, and observability](../features/web-mcp-observability.md). |
| `current_time` | Local date, time, weekday, and time zone. The system prompt has no date, so the model calls this when a task depends on today. Read-only. |
| `search_tools` | Load deferred tools (below) by task or name. Read-only. |

## Deferred tools

The system prompt lists these tools, but they are not in the model's tool list until `search_tools` loads them. This keeps the tool list small. A loaded tool stays loaded for the rest of the session and keeps its own approval policy. If the model calls a deferred tool before it is loaded, the call fails once with "not found" and the tool loads for the next step.

| Tool | What it does |
| --- | --- |
| `import_document` | Extract PDF, EPUB, DOCX, PPTX, or XLSX text into artifacts with citations. |
| `create_skill` | Create a skill package. Defaults to ask. YOLO does not auto-approve it. `/undo` cannot revert it. |
| `mcp__<id>__<tool>` | Opt-in remote MCP tools behind the approval gate. The system prompt lists one line per MCP server. |

## Removed tools

Before 1.0.0 these tools were merged or removed. Per-tool approval entries for the old names have no effect.

| Old tool | Use instead |
| --- | --- |
| `read_skill`, `read_skill_file` | `skill` with `action=read` or `action=read_file` |
| `load_skill`, `unload_skill` | `skill` with `action=read` (the body goes into the conversation) |
| `list_artifacts`, `read_artifact`, `search_artifact`, `export_artifact` | `artifact` with `action=list`, `read`, `search`, or `export` |
| `ls`, `search`, `find`, `grep`, `get_active_note`, `get_backlinks`, `get_links`, `local_graph`, `get_properties` | `vault_inspect` with `action=list`, `search`, `active_note`, `local_graph`, or `properties` |
