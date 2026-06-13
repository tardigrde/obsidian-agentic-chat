# Agentic Chat for Obsidian

An **agent-led AI chat** that lives in Obsidian's right sidebar. Instead of a plain chatbot, you get an agent that *acts on your vault*: it reads, searches, writes, and edits notes through typed tools — and every tool call is rendered inline in the chat timeline, so you always see what the agent is doing.

The agent core is built on the [pi](https://pi.dev) packages ([`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core) and [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)) and runs entirely inside Obsidian on **desktop and mobile**. Use it with hosted models through [OpenRouter](https://openrouter.ai) (with privacy-preserving provider routing) or with a fully local [Ollama](https://ollama.com) server.

## Features

- **Native sidebar chat** — an Obsidian `ItemView` styled with theme variables (light and dark just work). Tool calls appear as live step cards inside the assistant bubble; reasoning tokens stream into a collapsible section.
- **Vault tools** — the agent can `read`, `write`, `edit` (exact string replacements), `ls`, `find` (glob/substring), `grep`, `get_active_note`, `rename` (backlinks preserved via the file manager), and `delete` (to trash). All paths are vault-relative; absolute paths and `..` escapes are rejected.
- **Conversation persistence & history** — every conversation is stored as JSONL under the plugin folder and resumed automatically on reload. The history button (and `/sessions`) lists past conversations to reopen or delete. Works on mobile (no SQLite, no Node fs).
- **Token & cost tracking** — per-message and per-conversation token usage and USD cost, computed from pi's model catalog. See `/usage` and `/status`.
- **Local LLM support** — switch the provider to **Ollama** in settings for private, zero-cost inference against a local server (OpenAI-compatible endpoint).
- **Skills & personas** — drop `SKILL.md` files (agentskills.io frontmatter: `name`, `description`, body) into a vault folder; they are listed to the model and invokable with `/skill <name>`. A persona is just a skill whose body sets the agent's behaviour.
- **Prompt templates** — reusable prompts (with `$ARGUMENTS` / `$1` substitution) from a vault folder, invokable with `/template <name> [args]`.
- **Approval gates** — read-only tools run freely; mutating tools (`write`, `edit`, `rename`, `delete`) are gated by an **allow / ask / deny** policy. "Ask" shows a confirm dialog with the tool arguments and an optional "don't ask again".
- **Privacy-preserving model routing** (OpenRouter) — enforced per request:
  - *Deny prompt logging and training* → `data_collection: "deny"`.
  - *Require zero data retention* → `zdr: true` (strictest).
  - *Provider fallbacks* → optional, always respecting the rules above.
- **Slash commands** — `/new`, `/sessions`, `/model`, `/status`, `/usage`, `/skill`, `/template`, `/help`.
- **Context attachments** — one click attaches the active note or a folder listing to your next message.

## Architecture

```
src/
  agent/        # AgentService (wires the pi Agent), system prompt, approval policy
  llm/          # pi-ai model construction (OpenRouter + Ollama) and model listing
  tools/        # vault tools as pi AgentTools (read/write/edit/ls/find/grep/rename/delete/active)
  vault/        # path safety, exact edits, search, truncation helpers
  session/      # JSONL session entries + ObsidianSessionManager (vault-adapter backed)
  skills/       # SKILL.md + prompt-template loading from the vault
  ui/           # sidebar chat view, model/session/approval modals, folder picker
  settings.ts   # provider, model, thinking level, privacy, approval, skills/templates
  main.ts       # plugin entry point
```

The pi `Agent` owns the loop, streaming, and tool execution. The plugin supplies a `streamFn` (pi-ai `streamSimple` with request tuning + OpenRouter attribution headers), the model (with privacy routing baked into `compat.openRouterRouting`), the vault tools, skills, a `beforeToolCall` approval hook, and a JSONL session store backed by the Obsidian vault adapter.

## Installation

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release (or build them — see below).
2. Copy them into `<your vault>/.obsidian/plugins/agentic-chat/`.
3. Reload Obsidian and enable **Agentic Chat** in *Settings → Community plugins*.

### Via BRAT

Add `tardigrde/obsidian-agentic-chat` in the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.

## Setup

**OpenRouter (default):**
1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Open *Settings → Agentic Chat*, paste the key, pick a model (**Browse** lists tool-capable models; default `anthropic/claude-sonnet-4.5`).
3. Review **Privacy** — *Deny prompt logging and training* is on by default. With strict settings some models may have no compliant provider; pick another model or relax the setting.

**Ollama (local):**
1. Run a local Ollama server and pull a tool-capable model.
2. Set the provider to **Ollama (local)**, set the server URL (default `http://localhost:11434`) and model tag.

Then click the chat ribbon icon (or run *Agentic Chat: Open chat*).

## Privacy notes

- Prompts, attached/read note content, and tool results are sent to the configured provider (OpenRouter, subject to your routing constraints — or never leave your machine with Ollama).
- The API key is stored locally in the plugin's `data.json` inside `.obsidian`; don't sync it to untrusted places.
- The agent can modify your vault. Mutating tools are gated by the approval policy (default: **ask**), and deletes go to trash.

## Development

```bash
npm install
npm run dev        # esbuild watch mode
npm test           # vitest (path safety, exact edits, search, model routing, approval, sessions, skills, agent service)
npm run build      # typecheck + production bundle
```

The test suite runs without Obsidian: the `obsidian` package is replaced by a minimal mock via a vitest alias, the model stream by an injected `streamFn`, and the session store by an in-memory adapter.

## Acknowledgements

- Built on the [pi](https://pi.dev) packages by Mario Zechner (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`), MIT.
- Vault tool, path-safety, exact-edit, search, and JSONL session patterns were adapted from [`lhr0909/pi-obsidian`](https://github.com/lhr0909/pi-obsidian) by Simon Liang (MIT / 0BSD).

## License

[MIT](LICENSE)
