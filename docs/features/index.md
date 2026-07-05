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
- Search paths and note contents.
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

## Extensibility

- Skills loaded from vault `SKILL.md` files.
- Subagent profiles loaded from vault `AGENT.md` files.
- Optional web search and URL fetch.
- Optional HTTPS Streamable HTTP MCP tools.
- Optional OTLP or Langfuse observability export.
