# Semantic Retrieval

Semantic retrieval adds opt-in vector search over your notes. It is off by default; you choose the scope (vault, folder, tag, or the active note's folder) each time you index.

## How it works

1. **Index** — The plugin sends note text to an embedding provider and stores vectors in a local index file.
2. **Query** — The agent searches the index when keyword lookup (`vault_inspect`) is unlikely to find paraphrased or conceptually related notes.
3. **Scope** — Indexing covers exactly the scope you indexed. Re-run per scope; `/semantic-index estimate` shows note/token counts first so you know the embedding cost.

## When to use it vs alternatives

| Need | Use |
| --- | --- |
| Exact names, links, frontmatter | `vault_inspect` keyword search (free, always on) |
| "Notes about X" phrased differently than the notes | Semantic index (costs embedding calls) |
| Standing rules the agent must always follow | `AGENTS.md` via `/init` (auto-loaded every turn) |
| Facts across sessions | `/memory add` (explicit recall only) |

## Setup

Enable and configure embeddings in **Settings > Resources > Semantic retrieval**:

- **Provider** — OpenRouter, Ollama, or OpenAI-compatible.
- **Model** — The embedding model id (e.g., `openai/text-embedding-3-small` for OpenRouter, `nomic-embed-text` for Ollama).
- **Dimensions** — Expected vector size (default 1536).
- **Language coverage** — Multilingual, monolingual, or unknown. Used for diagnostics.
- **Batch size** — Notes per embedding request (default 32).
- **Max indexed characters per note** — Upper bound on text sent to the provider per note (default 12,000).

Provider API keys reuse the same secrets configured in **Settings > Agentic Chat** on the **Models** tab.

## Commands

| Command | What it does |
| --- | --- |
| `/semantic-index status` | Show current index state: scope, model, note count, last update. |
| `/semantic-index estimate` | Estimate how many notes and tokens an index would cover for the current scope. |
| `/semantic-index start` | Build or rebuild the index for the current scope. |
| `/semantic-index cancel` | Cancel an in-progress index build. |

## Privacy

- Embedding text is sent to the provider you configure — with a remote provider, note content leaves your device.
- The local index file lives inside the plugin directory (`semantic-index.json`).
- Use Ollama for fully local embeddings. See [Privacy](../guide/privacy.md) for the full egress contract.
