# Semantic retrieval

Semantic retrieval adds opt-in vector search over your notes. It is off by default. You choose the scope (vault, folder, tag, or the active note's folder) each time you index.

## How it works

1. To index, the plugin sends note text to an embedding provider and stores vectors in a local index file.
2. To query, the agent searches the index when keyword lookup with `vault_inspect` is unlikely to find paraphrased or related notes.
3. Indexing covers exactly the scope you index. Run it again for another scope. `/semantic-index estimate` shows note and token counts first, so you know the embedding cost.

A full-vault index requires `/semantic-index start vault --confirm-vault`. The plugin never starts a full-vault index without that flag.

## When to use it

| Need | Use |
| --- | --- |
| Exact names, links, frontmatter | `vault_inspect` keyword search (free, always on) |
| "Notes about X" phrased differently than the notes | Semantic index (uses embedding calls) |
| Standing rules the agent must always follow | `AGENTS.md` through `/init` (loaded every turn) |
| Facts across sessions | `/memory add` (explicit recall only) |

## Setup

Enable and configure embeddings in **Settings > Agentic Chat > Advanced > Semantic retrieval**:

- Provider: OpenRouter, Ollama, or OpenAI-compatible.
- Model: the embedding model id (for example, `openai/text-embedding-3-small` for OpenRouter or `nomic-embed-text` for Ollama).
- Dimensions: the expected vector size (default 1536).
- Language coverage: multilingual, monolingual, or unknown. Used for diagnostics.
- Batch size: notes per embedding request (default 32).
- Max indexed characters per note: upper bound on the text sent to the provider for one note (default 12,000).

Provider API keys reuse the secrets on the **Models** tab.

## Commands

| Command | What it does |
| --- | --- |
| `/semantic-index status` | Show the current index state: scope, model, note count, and last update. |
| `/semantic-index estimate` | Estimate how many notes and tokens an index would cover for the current scope. |
| `/semantic-index start` | Build or rebuild the index for the current scope. |
| `/semantic-index cancel` | Cancel an in-progress index build. |

## Privacy

- The plugin sends embedding text to the provider you configure. With a remote provider, note content leaves your device.
- The local index file is `semantic-index/index.json` inside the plugin directory.
- Use Ollama for fully local embeddings. See [Privacy](../guide/privacy.md) for the full egress contract.
