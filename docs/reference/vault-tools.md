# Vault tools

All tool paths are vault-relative. The plugin rejects absolute paths and `..` escapes.

Paths that match an ignore glob report as not found. The agent cannot read, list, search, or edit them.

## Read-only tools

| Tool | What it does |
| --- | --- |
| `read` | Read a note's contents, optionally bounded with `startLine` and `endLine`, or with byte `offset` and `limit`. |
| `vault_inspect` | Read-only meta-tool for vault context. Use `action=list` to list a folder, `action=search` to search file names and contents, `action=active_note` to read the active note, `action=local_graph` for a note's link neighborhood, or `action=properties` to read YAML frontmatter. |

Read-only tools run without approval unless working-directory scoping requires confirmation for an outside folder.

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

| Tool | What it does |
| --- | --- |
| `ask_user` | Inline clarification prompt. The answer steers the run. |
| `search_memory` | Explicit long-term memory lookup. Never automatic. See [Memory](../features/memory.md). |
| `subagent` | Delegates recon to the read-only Explorer, one level deep. |
| `load_skill` / `unload_skill` / `read_skill` | Load a skill body only when the agent needs it. |
| `create_skill` | Create a skill package. Defaults to ask. YOLO does not auto-approve it. `/undo` cannot revert it. |
| `read_artifact` / `search_artifact` / `list_artifacts` | Inspect large tool outputs kept out of context. |
| `import_pdf` / `import_document` | Extract PDF, EPUB, DOCX, PPTX, or XLSX text into artifacts with citations. |
| `web_search` / `fetch_url` | Opt-in web tools. See [Web, MCP, and observability](../features/web-mcp-observability.md). |
| `mcp__<id>__<tool>` | Opt-in remote MCP tools behind the approval gate. |

## Compatibility tools

The plugin keeps the following tools for backward compatibility but does not send them to the model by default. Use `vault_inspect` instead.

| Tool | Status | Preferred replacement |
| --- | --- | --- |
| `ls` | Compatibility | `vault_inspect` with `action=list` |
| `search` | Compatibility | `vault_inspect` with `action=search` |
| `find` | Compatibility | `vault_inspect` with `action=search` and `kind=files` |
| `grep` | Compatibility | `vault_inspect` with `action=search` and `kind=content` |
| `get_active_note` | Compatibility | `vault_inspect` with `action=active_note` |
| `get_backlinks` | Compatibility | `vault_inspect` with `action=local_graph` |
| `get_links` | Compatibility | `vault_inspect` with `action=local_graph` |
| `local_graph` | Compatibility | `vault_inspect` with `action=local_graph` |
| `get_properties` | Compatibility | `vault_inspect` with `action=properties` |

If you enable a compatibility tool in settings, it behaves as before. New setups use `vault_inspect`.
