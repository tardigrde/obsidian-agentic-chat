# Memory

Memory persists across sessions. It has four kinds and two scopes:

| Kind | Use for |
| --- | --- |
| `preference` | User likes and dislikes (for example, "prefer short bullet answers"). |
| `fact` | Factual knowledge about the vault or user (for example, "main project is in /Work/"). |
| `instruction` | Standing directives (for example, "always add a date header"). |
| `summary` | Condensed session takeaways (for example, "decided to migrate to new folder structure"). |

## Memory scopes

| Scope | Visibility |
| --- | --- |
| `global` | All vaults and sessions. |
| `vault` | Only this vault. |

## Commands

| Command | What it does |
| --- | --- |
| `/memory add [kind] [scope] <text>` | Store a new memory. Defaults to kind `fact` and scope `vault`. |
| `/memory review` | Browse stored memories in a searchable list. |
| `/memory manage` | Alias for `/memory review`. |
| `/memory export` | Export memories to a vault note. |
| `/memory clear --confirm` | Delete all stored memories. Requires `--confirm`. |

The plugin stores memories in `memories.jsonl` inside the plugin directory. It never injects them into context automatically. The agent must call the `search_memory` tool to retrieve them.

## When the agent uses memory

The conversation does not include memories by default. The agent calls `search_memory` when it needs stored knowledge. To force a lookup, ask a direct question such as "What do you remember about my preferences?". Use `/memory review` to see what is stored. Check for stale or wrong entries first when the agent does not use a memory you expected.
