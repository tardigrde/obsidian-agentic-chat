# Agentic Chat for Obsidian

An AI agent in the Obsidian sidebar that reads, searches, and edits your vault
through typed, visible, approval-gated tool calls. Desktop and mobile.

> **Experimental.** Settings and behavior change often. Pin a version if you
> need stability. Requires Obsidian 1.13.0+.

**[Docs](https://tardigrde.github.io/obsidian-agentic-chat/)** ·
[Recipes](docs/guide/recipes.md) ·
[Choosing a model](docs/guide/models.md) ·
[FAQ](docs/guide/faq.md) ·
[Settings](docs/reference/settings.md) ·
[Contributing](CONTRIBUTING.md)

## Why this one

- **You see every step.** Each turn has one activity line (`Read 4 notes,
  edited 1`); click it to see every tool call with its arguments, result, and
  timing.
- **Nothing changes without you.** Writes, edits, renames, and deletes ask first
  in an approval card in the chat, with a diff. `/undo` reverts the last change. Deletes go to trash; if no
  trash works, the file is removed permanently and the result says so.
- **Private by default.** OpenRouter requests go only to zero-data-retention,
  no-training endpoints. Or run fully local with Ollama. No telemetry.
- **Vault-native.** Renames update backlinks, frontmatter goes through
  Obsidian's API, and an ignore list hides folders from the agent's tools.
- **Extensible without code.** `SKILL.md` skills, remote MCP servers, a
  read-only Explorer subagent, and opt-in web search, all as plain vault files.

## Quickstart (5 minutes)

1. **Install.** *Settings → Community plugins → Browse →* "Agentic Chat".
   (Pre-releases: [BRAT](https://github.com/TfTHacker/obsidian42-brat) with
   `tardigrde/obsidian-agentic-chat`.)
2. **Connect a model.** *Settings → Agentic Chat → Models*: paste an
   [OpenRouter key](https://openrouter.ai/keys). The default model,
   `deepseek/deepseek-v4.1-flash`, is the one the eval suite runs on: cheap,
   fast, and good at tool use. Prefer local? Pick **Ollama** or any
   **OpenAI-compatible** gateway ([setup](docs/guide/setup.md)).
3. **Chat.** Click the ribbon icon (or run *Agentic Chat: Open chat*), open a
   note, and try:

```text
Summarize this note in 5 bullets and suggest 3 tags.
Find every note that mentions "Q3 planning" and list open action items with links.
Add `status: draft` to the frontmatter of every note in Inbox/.
```

Approve the diff, then run `/undo` to see the change reverted. More prompts in
[Recipes](docs/guide/recipes.md).

## Cheat sheet

| You want to | Do this |
| --- | --- |
| Add context | `@note`, `@note#heading`, `@note^block`, drag a file, or right-click → *Agentic Chat* |
| Steer a running turn | Type and press Enter while it works. **Queue** waits; **Stop** replaces |
| Skip approval prompts | Toggle **Safe → YOLO** in the composer (recursive deletes still ask) |
| Hide notes from the agent | *Advanced → Ignored files*, e.g. `Private/`, `**/diary/**` |
| Give the agent standing rules | Put them in `AGENTS.md` at the vault root, or run `/init` |
| Watch cost | The meta under each answer, `/usage`, the context ring, and a spend cap in *Advanced → Notifications* |
| Undo / rewind | `/undo` for the last vault change; click a sent message to edit and rerun |
| Debug setup | `/doctor`, then `/status` |

All commands: [Slash commands](docs/reference/slash-commands.md). All tools:
[Vault tools](docs/reference/vault-tools.md).

## What leaves your device

| Data | Goes to | When |
| --- | --- | --- |
| Prompts, attached/read notes, tool results | Your model provider (OpenRouter, Ollama, or gateway) | Every turn |
| OpenRouter model catalog request (no vault content) | openrouter.ai | When the local price cache is missing or older than 3 days |
| Search queries, fetched URLs | Tavily / Brave / SearXNG and the target sites | Only with **Web access** on |
| Tool arguments | Your MCP servers | Only for MCP servers you enabled |
| Trace metadata (prompts only if you choose) | Your Langfuse / OTLP endpoint | Only with **Observability** on |

API keys and tokens live in Obsidian secret storage, not in `data.json`.
Details and the Obsidian developer-policy disclosures:
[Privacy model](docs/guide/privacy.md).

## Desktop and mobile

Everything works on both, with three desktop-only exceptions:

- **Proxy support.** The plugin's HTTP proxy uses Obsidian desktop's Node networking path. On mobile, leave the plugin proxy fields empty and use the device, VPN, or network proxy.
- **MCP OAuth.** OAuth sign-in uses a localhost callback on desktop and an `obsidian://agentic-chat-mcp-oauth` callback on mobile. Providers that require localhost redirects still require Obsidian desktop sign-in (or bearer / static-header auth).
- **Agent plugin import from a vault folder.** GitHub URLs and archives work
  everywhere.

## Documentation

| Start | Go deeper | Reference |
| --- | --- | --- |
| [Install](docs/guide/install.md) | [Context and control](docs/features/context-and-control.md) | [Settings](docs/reference/settings.md) |
| [Setup](docs/guide/setup.md) | [Skills, subagents, AGENTS.md](docs/features/agent-workflows.md) | [Slash commands](docs/reference/slash-commands.md) |
| [Daily usage](docs/guide/usage.md) | [Agent plugins](docs/features/agent-plugins.md) | [Vault tools](docs/reference/vault-tools.md) |
| [Recipes](docs/guide/recipes.md) | [Web, MCP, observability](docs/features/web-mcp-observability.md) | [FAQ and glossary](docs/guide/faq.md) |
| [Choosing a model](docs/guide/models.md) | [Privacy model](docs/guide/privacy.md) | [Troubleshoot](docs/guide/troubleshoot.md) |

The same pages, searchable:
[tardigrde.github.io/obsidian-agentic-chat](https://tardigrde.github.io/obsidian-agentic-chat/).

## Contributing

```bash
npm install && npm run dev:vault -- ~/MyTestVault   # build into a vault with hot reload
npm run verify -- plan                              # what your diff must pass
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Release validators also run
`npm run verify:provider-live` (live credentials required). Architecture, test lanes, evals,
and the review process live in [docs/development](docs/development/index.md).
[ROADMAP.md](ROADMAP.md) lists planned work.

## Acknowledgements

- Built on the [pi](https://pi.dev) packages by Mario Zechner
  (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`), MIT.
- Vault tool, path-safety, exact-edit, search, and JSONL session patterns were
  adapted from [`lhr0909/pi-obsidian`](https://github.com/lhr0909/pi-obsidian)
  by Simon Liang (MIT / 0BSD).

## License

[MIT](LICENSE). Bundled dependencies and adapted code:
[third-party notices](THIRD_PARTY_NOTICES.md).
