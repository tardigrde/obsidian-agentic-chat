# Feature Map

Agentic Chat turns the Obsidian sidebar into an agent workspace rather than a plain chatbot.

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
- Trash-safe file and empty-folder deletes.

## Agent workflows

- Inline clarification prompts with `ask_user`.
- Safe and YOLO approval postures.
- Sticky read-only plan mode.
- Working directories for scoped auto-approval.
- Gitignore-style ignore list.
- `/undo` for the most recent vault mutation.
- Long-session compaction before context overflow, plus `/compact [instructions]` for manual compaction.
- Token, cost, next-request estimate, cost alert, and spend-cap readouts.
- Real-time turn steering with `/steer`, queued follow-ups with `/follow-up`, and hard redirects with `/redirect`.
- Reasoning effort control via `/effort`.

## Project workspaces

- Create project workspaces that scope notes, tools, model/profile, and sessions.
- Switch projects with `/project` to change the active working set on the fly.
- Projects apply scoped folders, model overrides, output style, system prompt, and tool toggles (web/MCP).

## Memory

- Long-term memory with kinds: preference, fact, instruction, summary.
- Scopes: global, vault, project.
- Add memories with `/memory add`.
- Search memories with the `search_memory` tool.
- Export or clear memory stores.

## Semantic retrieval

- Opt-in semantic index over vault notes.
- Configurable embedding provider (OpenRouter, Ollama, OpenAI-compatible).
- Scoped indexing by vault, folder, tag, or project.
- `/semantic-index` commands to estimate, start, or cancel indexing.

## Document import

- Import PDF, EPUB, DOCX, PPTX, and XLSX files into plugin-managed source artifacts.
- `import_pdf` and `import_document` tools extract text with provenance and citation anchors.
- Artifact chunks are inspectable with `read_artifact` and `search_artifact`.

## Extensibility

- Skills loaded from vault `SKILL.md` files.
- Built-in self-knowledge skill with tool inventory, doomloop guards, and error patterns.
- Subagent profiles loaded from vault `AGENT.md` files.
- Built-in subagents: researcher, reviewer, editor.
- Optional web search and URL fetch.
- Optional HTTPS Streamable HTTP MCP tools.
- Optional OTLP or Langfuse observability export.
- Artifact system for large tool outputs and external inspection cache entries.
- `read_skill` tool to load full skill content on demand.

## Todo tracking

- `/todo` commands to track milestones, tests, and checkpoint commits.
- Integrates with the plan tracker panel for visual progress.
