# Memory

Persists across sessions with four kinds and two scopes:

| Kind | Use for |
| --- | --- |
| `preference` | User likes and dislikes (e.g., "prefer short bullet answers"). |
| `fact` | Factual knowledge about the vault or user (e.g., "main project is in /Work/"). |
| `instruction` | Standing directives (e.g., "always add a date header"). |
| `summary` | Condensed session takeaways (e.g., "decided to migrate to new folder structure"). |

## Memory scopes

| Scope | Visibility |
| --- | --- |
| `global` | All vaults and sessions. |
| `vault` | Only this vault. |

## Commands

| Command | What it does |
| --- | --- |
| `/memory add [kind] [scope] <text>` | Store a new memory. Defaults to kind `fact`, scope `vault`. |
| `/memory review` | Browse stored memories in a searchable list. |
| `/memory manage` | Alias for `/memory review`. |
| `/memory export` | Export memories to a vault note. |
| `/memory clear --confirm` | Delete all stored memories. Requires confirmation. |

Memories are stored in `memories.jsonl` inside the plugin directory. They are **never injected into context automatically**; the agent must call the `search_memory` tool to retrieve them.

## When the agent uses memory

Memories are never injected automatically — the agent calls the `search_memory` tool only when the conversation suggests stored knowledge is relevant. To force a lookup, ask explicitly: "What do you remember about my preferences?" Use `/memory review` to see what is stored; stale or wrong entries explain most "it forgot" reports.
