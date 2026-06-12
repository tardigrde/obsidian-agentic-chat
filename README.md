# Agentic Chat for Obsidian

An **agent-led AI chat** that lives in Obsidian's right sidebar. Instead of a plain chatbot, you get an agent that *acts on your vault*: it reads, searches, lists, and writes notes through typed tools — and every tool call is rendered inline in the chat timeline, so you always see what the agent is doing and why.

Powered by [OpenRouter](https://openrouter.ai) with first-class **privacy-preserving provider routing**.

## Features

- **Native sidebar chat** — an Obsidian `ItemView` in the right sidebar, styled entirely with Obsidian theme variables (light and dark mode just work).
- **Agent transparency** — tool calls appear as live step cards inside the assistant bubble: `Reading note: Projects/Ideas.md`, spinner while running, collapsible result or error when done. Reasoning tokens (for models that emit them) stream into a collapsible "Reasoning" section.
- **Vault tools** — the agent can `read_note`, `write_note` (create / overwrite / append, with automatic parent-folder creation), `list_folder`, `search_vault`, and `get_active_note`.
- **Context attachments** — one click attaches the active note or any folder listing to your next message as short-term context.
- **Privacy-preserving model routing** — enforced per request via OpenRouter provider preferences:
  - *Deny prompt logging and training* → `provider.data_collection: "deny"` (only providers that don't store or train on your prompts).
  - *Require zero data retention* → `provider.zdr: true` (only ZDR endpoints; strictest).
  - *Provider fallbacks* → optional, and fallbacks always respect the rules above.
- **Robust by design** — streaming SSE client with timeouts, exponential-backoff retries on rate limits and transient server errors, friendly error messages for invalid keys / missing credits / moderation blocks, and a Stop button that aborts mid-run.
- **Multi-turn** — full conversation history (including tool results) is replayed each turn; "New chat" resets it.

## Architecture

The agent core is a TypeScript adaptation of the ideas in [Pydantic AI](https://ai.pydantic.dev):

| Pydantic AI | This plugin |
| --- | --- |
| `Agent` with system prompt + tools | `Agent<Deps>` (`src/agent/agent.ts`) |
| Pydantic-validated tool args | [Zod](https://zod.dev) schemas, converted to JSON Schema for the model (`src/agent/tool.ts`) |
| `RunContext` / dependency injection | `RunContext<Deps>` passed to every tool |
| `ModelRetry` | `ModelRetry` — a tool throws it and the message is fed back to the model, bounded by a per-tool retry budget |
| Model abstraction | `Model` interface; `OpenRouterModel` is the production implementation, `FakeModel` powers the tests |

The execution loop streams events (`run_start`, `step_start`, `text_delta`, `reasoning_delta`, `tool_call_start/end`, `run_end`, `run_error`) that both the UI timeline and the `ConversationStore` consume — the UI never interprets model output itself.

```
src/
  agent/        # types, errors, tool schema layer, execution loop
  llm/          # OpenRouter streaming client + SSE parser
  tools/        # vault tools (read/write/list/search/active note)
  state/        # UI-agnostic conversation store
  ui/           # sidebar chat view + folder picker
  settings.ts   # settings tab (API key, model browser, privacy, agent limits)
  main.ts       # plugin entry point
```

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release (or build them — see below).
2. Copy them into `<your vault>/.obsidian/plugins/agentic-chat/`.
3. Reload Obsidian and enable **Agentic Chat** in *Settings → Community plugins*.

### Via BRAT

Add `tardigrde/obsidian-agentic-chat` in the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.

## Setup

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Open *Settings → Agentic Chat*, paste the key.
3. Pick a model — **Browse** lists only models that support tool calling. The default is `anthropic/claude-sonnet-4.5`.
4. Review the **Privacy** section. *Deny prompt logging and training* is **on by default**. Note that with strict privacy settings some models may have no compliant provider, which surfaces as a "no endpoint found" error — pick another model or relax the setting.
5. Click the chat ribbon icon (or run the *Agentic Chat: Open chat* command).

## Privacy notes

- Your messages and any attached/read note content are sent to the model provider selected by OpenRouter, subject to the privacy constraints you configure. Nothing else leaves your vault.
- The API key is stored locally in the plugin's `data.json` inside your vault's `.obsidian` folder — don't sync it to untrusted places.
- The agent can **write** to your vault via `write_note`. Every write is shown as a step card with its arguments; `create` mode never overwrites an existing note.

## Development

```bash
npm install
npm run dev        # esbuild watch mode
npm test           # vitest (68 tests: agent loop, tool validation, SSE/streaming, retries, state, vault tools)
npm run build      # typecheck + production bundle
```

The test suite runs without Obsidian: the `obsidian` package is replaced by a minimal mock via a vitest alias, the model layer by a scripted `FakeModel`, and the vault by an in-memory `FakeVault`.

## License

[MIT](LICENSE)
