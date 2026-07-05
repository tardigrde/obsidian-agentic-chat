# Vault Tools

All tool paths are vault-relative. Absolute paths and `..` escapes are rejected.

Paths matched by the ignore list report as not found, so the agent cannot read, list, search, or edit them.

## Read-only tools

| Tool | What it does |
| --- | --- |
| `read` | Read a note's contents, optionally bounded with `startLine`/`endLine` or byte `offset`/`limit`. |
| `ls` | List a folder. |
| `search` | Search note paths and contents with result caps and optional folder scope. |
| `get_active_note` | Read the note currently open in the editor. |
| `local_graph` | Return a note's immediate inbound and outbound link neighborhood. |
| `get_properties` | Read a note's YAML frontmatter as structured data. |

Read-only tools run without approval unless working-directory scoping requires an outside-folder confirmation.

## Mutating tools

| Tool | What it does |
| --- | --- |
| `write` | Create or overwrite a note. |
| `edit` | Replace exact strings within a note. |
| `set_properties` | Write YAML frontmatter through Obsidian APIs. |
| `rename` | Rename or move a note and preserve inbound wikilinks and backlinks. |
| `delete` | Move a note or empty folder to trash. |

Mutating tools are controlled by the approval policy and can be reverted with `/undo` when they are the latest agent vault mutation.

## Compatibility tools

The model-facing graph surface uses `local_graph`. Compatibility implementations for older internal surfaces still exist for `get_backlinks`, `get_links`, `find`, and `grep`.
