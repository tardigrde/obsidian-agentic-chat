# Semantic Retrieval

Semantic retrieval adds vector-based note search to the agent. It is opt-in and scoped so you control exactly what gets indexed and when.

## How it works

1. **Index** — The plugin sends note text to an embedding provider and stores the resulting vectors in a local index file.
2. **Query** — When the agent needs relevant context, the index returns the most semantically similar notes.
3. **Scope** — Indexing is scoped to a vault, folder, tag, or project workspace. You choose the scope each time you index.

## Setup

Enable and configure embeddings in **Settings > Resources > Semantic retrieval**:

- **Provider** — OpenRouter, Ollama, or OpenAI-compatible.
- **Model** — The embedding model id (e.g., `openai/text-embedding-3-small` for OpenRouter, `nomic-embed-text` for Ollama).
- **Dimensions** — Expected vector size (default 1536).
- **Language coverage** — Multilingual, monolingual, or unknown. Used for diagnostics.
- **Batch size** — Notes per embedding request (default 32).
- **Max indexed characters per note** — Upper bound on text sent to the provider per note (default 12,000).

Provider API keys reuse the same secrets configured in **Settings > Models**.

## Commands

| Command | What it does |
| --- | --- |
| `/semantic-index status` | Show current index state: scope, model, note count, last update. |
| `/semantic-index estimate` | Estimate how many notes and tokens an index would cover for the current scope. |
| `/semantic-index start` | Build or rebuild the index for the current scope. |
| `/semantic-index cancel` | Cancel an in-progress index build. |

When a project is active, `/semantic-index` scopes to the project folders automatically.

## Privacy

- Embeddings are sent to the provider you configure. If you use a remote provider, note content leaves your device.
- The local index file lives inside the plugin directory (`semantic-index.json`).
- Use Ollama for fully local embeddings.
