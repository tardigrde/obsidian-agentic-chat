# Feature map

Agentic Chat is a sidebar chat panel (`ItemView`) with streaming answers, inline tool-call step cards, session tabs, and approval-gated vault edits.

## Core chat

- Native Obsidian `ItemView` in the sidebar.
- Streaming assistant output.
- Inline tool-call step cards.
- Reasoning tokens in a collapsible section when the model provides them.
- Obsidian-style Markdown rendering, including callouts and Mermaid diagrams.
- Session tabs, history browsing, rename, delete, export, and clear actions.

## Vault work

- Read and write notes.
- Edit notes by exact replacement.
- Search paths and note contents through the unified `vault_inspect` meta-tool.
- Traverse local note graph context.
- Read and update YAML frontmatter through Obsidian APIs.
- Rename notes with backlink preservation.
- Trash-safe deletes. Files and folders go to trash. A non-empty folder needs `recursive:true`, which asks even in YOLO unless deletes are explicitly allowed per tool.

## Agent workflows

- Inline clarification prompts with `ask_user`.
- Safe and YOLO approval postures.
- Gitignore-style ignore list.
- `/undo` for the most recent vault mutation.
- Long-session compaction before context overflow, plus `/compact [instructions]` for manual compaction.
- Token, cost, next-request estimate, cost alert, and spend-cap readouts.
- Real-time composer control: Enter steers the active turn, **Queue** holds a draft until the turn ends, and **Stop** then send replaces the turn.
- Reasoning effort control through `/effort`.

## Memory

- Long-term memory with kinds: preference, fact, instruction, summary.
- Scopes: global, vault.
- Add memories with `/memory add`.
- Search memories with the `search_memory` tool.
- Export or clear memory stores.

## Semantic retrieval

- Opt-in semantic index over vault notes.
- Configurable embedding provider (OpenRouter, Ollama, OpenAI-compatible).
- Scoped indexing by vault, folder, tag, or the active note's folder.
- `/semantic-index` commands to estimate, start, or cancel indexing.

## Document import

- Import PDF, EPUB, DOCX, PPTX, and XLSX files into plugin-managed source artifacts.
- `import_pdf` and `import_document` tools extract text with provenance and citation anchors.
- Artifact chunks are inspectable with `read_artifact` and `search_artifact`.

## Extensibility

- [Agent plugins](agent-plugins.md): packages in the vault (`.agentic-plugins/`) that follow the Agent Plugins 1.0.0 spec and contribute skills and MCP servers.
- Skills loaded from plugin `SKILL.md` files, alongside built-in skills. Plugin skills load first and win name collisions.
- Built-in self-knowledge skill with tool inventory, loop guards, and error patterns.
- Read-only Explorer subagent for recon delegation (single built-in role, one level deep).
- Optional web search and URL fetch.
- Optional Streamable HTTP MCP tools over HTTPS, or loopback HTTP for local servers. Generated into plugin packages from the settings UI.
- `/doctor` audit of agent plugin spec compliance.
- Optional OTLP or Langfuse observability export.
- Artifact system for large tool outputs.
- `read_skill` tool to load full skill content on demand.
