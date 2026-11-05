---
layout: home

hero:
  name: Agentic Chat
  text: Agent-led AI chat for Obsidian
  tagline: A sidebar assistant that reads, searches, and edits your vault through visible, approval-gated tool calls. OpenRouter zero-retention routing is on by default. Web, MCP, and observability are off, and the plugin sends no telemetry.
  actions:
    - theme: brand
      text: Install
      link: /guide/install
    - theme: alt
      text: First chat in 5 minutes
      link: /guide/setup#first-chat
    - theme: alt
      text: View commands
      link: /reference/slash-commands

features:
  - title: Vault-native tools
    details: Read, search, write, edit, rename, and delete through Obsidian APIs. Deletes use trash, renames preserve backlinks, and the ignore list stays invisible.
  - title: Privacy defaults
    details: OpenRouter routing requires zero-retention endpoints and denies training and logging. Ollama keeps prompts local. The plugin sends no telemetry.
  - title: Visible control
    details: Every tool call renders inline with arguments and timing. Mutating calls show diffs for approval. Plan mode blocks writes, and /undo reverts the last change.
  - title: Opt-in power only
    details: Web research, remote MCP tools, semantic indexing, and observability export stay off until you enable them in Settings.
---
