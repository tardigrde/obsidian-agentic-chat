# Agentic Chat for Obsidian

A **privacy-first, agent-led AI chat** in Obsidian's right sidebar. Instead of a plain chatbot, you get an agent that *acts on your vault*: it reads, searches, writes, and edits notes through typed tools — and every tool call is rendered inline in the chat, so you always see exactly what the agent is doing.

It runs entirely inside Obsidian on **desktop and mobile**, built on the [pi](https://pi.dev) agent packages. Use it with hosted models through [OpenRouter](https://openrouter.ai) — locked to **zero-data-retention** providers by default — or with a fully local [Ollama](https://ollama.com) server where nothing ever leaves your machine.

## Privacy first

Your notes are yours. This plugin is built so that using AI on them does not mean handing them to a model trainer.

- **Zero data retention by default.** Out of the box, OpenRouter requests are routed only to endpoints that retain nothing (`zdr: true`) *and* don't log or train on prompts (`data_collection: "deny"`). Provider fallbacks are allowed but must satisfy the **same** constraints — a fallback is never a privacy downgrade.
- **Or go fully local.** Switch the provider to Ollama and every prompt, note, and tool result stays on your device. No API key, no network, no cost.
- **No telemetry.** The plugin collects nothing, phones home to nothing, and ships no analytics. The only network traffic is the model request you trigger, to the provider you chose.
- **You see everything the agent does.** Every read, search, write, edit, rename, and delete is a visible tool call in the timeline. Mutating actions are gated by an approval policy (default: **ask**), and deletes go to trash.
- **Your key stays local.** The OpenRouter API key is stored only in the plugin's `data.json` inside your vault's `.obsidian` folder.

> With the strict zero-data-retention default, some models may have no compliant provider on OpenRouter. If a request can't be routed, pick a different model in settings, relax the privacy toggles deliberately, or use Ollama.

## Features

- **Native sidebar chat** — an Obsidian `ItemView` styled with theme variables (light and dark just work). Tool calls appear as live step cards; reasoning tokens stream into a collapsible section.
- **Vault tools** — the agent can `read`, `write`, `edit` (exact string replacements), `ls`, `find` (glob/substring), `grep`, `get_active_note`, `rename` (backlinks preserved), and `delete` (to trash). All paths are vault-relative; absolute paths and `..` escapes are rejected.
- **Approval gates** — read-only tools run freely; mutating tools are gated **allow / ask / deny**, globally or per tool. "Ask" shows a confirm dialog with the exact arguments.
- **Ignore list** — gitignore-style globs (e.g. `Private/`, `*.secret.md`, `**/diary/**`) name notes the agent can never touch. Enforced at the tool layer: matching files are invisible to *every* tool — they report as "not found", so the agent can't read, list, search, or edit them.
- **Conversation history** — every chat is stored as JSONL under the plugin folder and resumed on reload; browse, reopen, or delete past conversations. Works on mobile (no SQLite, no Node `fs`).
- **Token & cost tracking** — per-message and per-conversation token usage and USD cost (`/usage`, `/status`).
- **Skills & personas** — drop `SKILL.md` files into a vault folder; they're offered to the agent and invokable with `/skill <name>`.
- **Web access (opt-in)** — off by default. Turn on *Web access* in settings to give the agent `web_search` (Tavily / Brave / SearXNG backend) and `fetch_url` (read a page as text). When on, a built-in `/skill deep-research` runs a plan→search→read→cite loop and writes a sourced note. Egress-gated: while it's off the tools aren't registered, so nothing leaves your device for the web.
- **Prompt templates** — reusable prompts with `$ARGUMENTS` / `$1` substitution, invokable with `/template <name> [args]`.
- **Context attachments** — one click attaches the active note or a folder listing to your next message.
- **Slash commands** — `/new`, `/sessions`, `/model`, `/status`, `/usage`, `/skill`, `/template`, `/help`.

## Disclosures

In the interest of transparency (and the [Obsidian Developer Policies](https://docs.obsidian.md/Developer+policies)):

- **Network use.** When the provider is OpenRouter, your prompt — including any note content you attach or the agent reads, plus tool results — is sent to OpenRouter and the model provider it routes to, subject to the privacy constraints above. With Ollama, requests go only to your configured local server. **Web access** is a separate, off-by-default opt-in: when enabled, search queries and the URLs the agent opens are sent to your chosen search provider (Tavily/Brave/SearXNG) and the fetched sites — outside the model-provider privacy boundary.
- **Account & payment.** OpenRouter requires your own account and API key, and hosted models are billed by OpenRouter to that account. The plugin itself is free and takes no payment. Ollama needs no account and is free.
- **File access.** The agent reads and modifies files in your vault through Obsidian's vault API, only when you prompt it. Mutating actions are gated by the approval policy; deletes move files to trash. Files matched by your ignore list are never exposed to the agent.
- **Telemetry.** None. No analytics, no tracking, no background network calls.
- **Source.** Fully open source under the MIT license.

## Install

### Via BRAT (recommended)

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then add `tardigrde/obsidian-agentic-chat` as a beta plugin. BRAT keeps it updated as new releases ship — the simplest way to install while the plugin is in pre-release.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/tardigrde/obsidian-agentic-chat/releases) (or build them — see [Development](#development)).
2. Copy them into `<your vault>/.obsidian/plugins/agentic-chat/`.
3. Reload Obsidian and enable **Agentic Chat** in *Settings → Community plugins*.

## Setup

**OpenRouter (default, zero data retention):**

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Open *Settings → Agentic Chat*, paste the key, and pick a model. **Browse** lists tool-capable models — and while zero data retention is on, only models that have a ZDR-compliant endpoint, so you can't pick one the privacy routing would reject. The default is `moonshotai/kimi-k2.6`.
3. The strict privacy defaults are on. To use a model with no ZDR provider, relax the routing toggles deliberately — Browse then shows the full catalog.

**Ollama (fully local):**

1. Run a local Ollama server and pull a tool-capable model.
2. Set the provider to **Ollama (local)**, then the server URL (default `http://localhost:11434`) and model tag.

Then click the chat ribbon icon, or run *Agentic Chat: Open chat*.

## Usage

- Type a message and press Enter. Use **+ Active note** or **+ Folder** to attach context.
- Watch the agent work: each tool call is a step card you can expand to see arguments and results.
- When a mutating tool is gated by "ask", a dialog shows the exact arguments — **Allow** (Enter) or **Deny** (Escape), with an optional "don't ask again for this tool".
- Slash commands (`/help` lists them) run locally and are not sent to the model.

## How privacy routing works

Privacy settings are applied to **every** OpenRouter request via the provider routing options:

| Setting | Effect | Default |
|---|---|---|
| Require zero data retention | `zdr: true` — only endpoints that retain nothing | **on** |
| Deny prompt logging and training | `data_collection: "deny"` | **on** |
| Allow provider fallbacks | `allow_fallbacks: true` — fallbacks still obey the two rules above | on |

Tightening these can leave a model with no compliant provider; that's the intended trade-off of privacy over convenience. Ollama bypasses all of this by never leaving your machine.

## Development

```bash
npm install
npm run dev        # esbuild watch mode
npm test           # vitest (path safety, exact edits, search, routing, approval, sessions, skills, agent service)
npm run typecheck  # tsc — the lint gate
npm run build      # typecheck + production bundle
```

The test suite runs without Obsidian: the `obsidian` package is replaced by a minimal mock via a vitest alias, the model stream by an injected `streamFn`, and the session store by an in-memory adapter. See `CLAUDE.md` for architecture notes.

## Acknowledgements

- Built on the [pi](https://pi.dev) packages by Mario Zechner (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`), MIT.
- Vault tool, path-safety, exact-edit, search, and JSONL session patterns were adapted from [`lhr0909/pi-obsidian`](https://github.com/lhr0909/pi-obsidian) by Simon Liang (MIT / 0BSD).

## License

[MIT](LICENSE)
