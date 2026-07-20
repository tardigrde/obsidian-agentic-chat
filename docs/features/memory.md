# Memory

Memory stores long-term facts, preferences, instructions, and summaries that persist across sessions.

## Memory kinds

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
| `project` | Only the active project (filtered until project context is active). |

## Commands

| Command | What it does |
| --- | --- |
| `/memory add [kind] [scope] <text>` | Store a new memory. Kind and scope default to `preference` and `vault` if omitted. |
| `/memory review` | Browse stored memories in a searchable list. |
| `/memory manage` | Alias for `/memory review`. |
| `/memory export` | Export memories to a vault note. |
| `/memory clear --confirm` | Delete all stored memories. Requires confirmation. |

Memories are stored in `memories.jsonl` inside the plugin directory. They are **never injected into context automatically**; the agent must call the `search_memory` tool to retrieve them.

## When the agent uses memory

The model decides when to search memory based on the conversation. You can prompt it explicitly: "What do you remember about my preferences?"

## Privacy

- Memories are local files inside the plugin directory.
- Nothing is sent to providers unless the agent calls `search_memory` and the result is included in the prompt.
- Clear memories with `/memory clear` if you want to reset.
