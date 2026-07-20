# Vault Tools

All tool paths are vault-relative. Absolute paths and `..` escapes are rejected.

Paths matched by the ignore list report as not found, so the agent cannot read, list, search, or edit them.

## Read-only tools

| Tool | What it does |
| --- | --- |
| `read` | Read a note's contents, optionally bounded with `startLine`/`endLine` or byte `offset`/`limit`. |
| `vault_inspect` | Read-only meta-tool for vault context. Use `action=list` to list a folder, `action=search` to search file names and contents, `action=active_note` to read the active note, `action=local_graph` for a note's link neighborhood, or `action=properties` to read YAML frontmatter. |

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

The following tools remain implemented for backward compatibility but are **not sent to the model by default**. The preferred surface is `vault_inspect`.

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

If a compatibility tool is explicitly enabled in settings, it behaves the same as before. `vault_inspect` is the default surface for new setups.
