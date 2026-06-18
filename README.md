# Agentic Chat for Obsidian

A **privacy-first, agent-led AI chat** in Obsidian's right sidebar. Instead of a plain chatbot, you get an agent that *acts on your vault*: it reads, searches, writes, edits, renames, traverses links, and reads/writes frontmatter through typed tools — and every tool call is rendered inline in the chat, so you always see exactly what the agent is doing.

It runs entirely inside Obsidian on **desktop and mobile**, built on the [pi](https://pi.dev) agent packages. Use it with hosted models through [OpenRouter](https://openrouter.ai) — locked to **zero-data-retention** providers by default — or with a fully local [Ollama](https://ollama.com) server where nothing ever leaves your machine.

## Privacy first

Your notes are yours. This plugin is built so that using AI on them does not mean handing them to a model trainer.

- **Zero data retention by default.** Out of the box, OpenRouter requests are routed only to endpoints that retain nothing (`zdr: true`) *and* don't log or train on prompts (`data_collection: "deny"`). Provider fallbacks are allowed but must satisfy the **same** constraints — a fallback is never a privacy downgrade.
- **Or go fully local.** Switch the provider to Ollama and every prompt, note, and tool result stays on your device. No API key, no network, no cost.
- **No telemetry.** The plugin collects nothing, phones home to nothing, and ships no analytics. The only network traffic is the model request you trigger, to the provider you chose.
- **You see everything the agent does.** Every read, search, write, edit, rename, and delete is a visible tool call in the timeline. Mutating actions are gated by an approval policy (default: **ask**), the approval dialog shows a **diff** of the pending change, and deletes go to trash.
- **Your key stays local.** The OpenRouter API key is stored only in the plugin's `data.json` inside your vault's `.obsidian` folder.

> With the strict zero-data-retention default, some models may have no compliant provider on OpenRouter. If a request can't be routed, pick a different model in settings, relax the privacy toggles deliberately, or use Ollama.

## Features

- **Native sidebar chat** — an Obsidian `ItemView` styled with theme variables (light and dark just work). Tool calls appear as live step cards with elapsed-time timing; reasoning tokens stream into a collapsible section; an animated indicator shows while the agent is working.
- **Vault tools** — the agent reads and acts on your vault through typed, path-safe tools (see [Vault tools](#vault-tools) for the full list): read/write/edit notes, list/find/grep, traverse backlinks and the local graph, read/write frontmatter as structured data, rename (backlinks preserved), and delete (to trash).
- **Approval gates with diff preview** — read-only tools run freely; mutating tools are gated **allow / ask / deny**, globally or per tool. "Ask" shows a confirm dialog with the exact arguments **and a line-level diff** of what would change, plus an optional "don't ask again for this tool."
- **Undo** — `/undo` reverts the agent's most recent vault change (write/edit/delete/rename/frontmatter).
- **Safe ↔ YOLO toggle** — a single composer switch over the approval gate. **Safe** honors your settings approval policy; **YOLO** is a session master switch that auto-approves all mutating tools (a per-tool *deny* still wins).
- **Working directories** — grant folders as a working set (composer folder button, `/add-dir`, or settings). In Safe mode the agent then **auto-runs reads/writes inside** them and **asks before touching anything outside** — even reads. Granted folders show as removable "scope" chips; `/dirs` lists/revokes them. Empty = approval applies vault-wide. (The ignore list still wins inside a granted folder.)
- **Plan mode** — `/plan` enters a sticky, read-only planning state (all mutations blocked) until `/endplan` restores your prior Safe/YOLO posture. A "Plan" badge shows in the composer while active.
- **Ignore list** — gitignore-style globs (e.g. `Private/`, `*.secret.md`, `**/diary/**`) name notes the agent can never touch. Enforced at the tool layer: matching files are invisible to *every* tool — they report as "not found", so the agent can't read, list, search, or edit them.
- **Conversation history** — every chat is stored as JSONL under the plugin folder and resumed on reload. Browse, search/filter, reopen, rename, or delete past conversations; sessions are auto-titled from the first prompt. Works on mobile (no SQLite, no Node `fs`).
- **Token, cost & context management** — per-message and per-conversation token/USD usage (`/usage`, `/status`), a pre-send "next ~$x" estimate, a one-time **cost alert**, a hard **spend cap** that blocks/aborts at a limit, and a context-window progress bar. Long sessions **auto-compact** older turns into a summary before they overflow the model's window.
- **Subagents (delegation)** — the agent can fan out focused child agents, each with its own context window, model, and tool subset, then merge their summaries. Drop `AGENT.md` profiles in a vault folder or use the built-in roster; invoke with `/agent <name> <task>`. See [Subagents](#subagents).
- **Skills** — drop `SKILL.md` files into a vault folder; they're offered to the agent (name + description only, body loaded on demand) and invokable with `/skill <name>` or directly as `/<name>`. Skills with `$ARGUMENTS` / `$1` absorb the old "prompt template" concept. See [Skills](#skills).
- **Output styles** — switch *how* the assistant talks (default / brainstorm / learning) with `/style`.
- **Durable memory** — a persisted set of facts and instructions the agent carries across every conversation, authored in settings (or grown by the agent itself). Surfaced as a system-prompt overlay; the agent reads it with `recall` and adds to it with `remember` (gated like any mutating tool). See [Durable memory](#durable-memory).
- **Web access (opt-in)** — off by default. Turn on *Web access* in settings to give the agent `web_search` (Tavily / Brave / SearXNG backend) and `fetch_url`, plus a built-in `/deep-research` skill. Egress-gated: while it's off the tools aren't registered, so nothing leaves your device for the web. See [Web access & research](#web-access--research).
- **Composer power tools** — a single unified input card holds the context chips, the textarea, and the bottom toolbar (model · effort · context · folders · Safe↔YOLO), with the session tabs and history/new-chat actions as a nav row above it. Plus inline autocomplete (`/` commands & skills, `@` note mentions), the active note auto-attached as a removable chip, drag-and-drop a note or folder to attach it, copy/retry buttons on every answer, prompt editing (click a sent message to rewind), shell-style up/down command history, a model pill with a per-request model override, and a settings page split into virtual tabs.

## Vault tools

All paths are vault-relative; absolute paths and `..` escapes are rejected, and any path matched by your [ignore list](#features) reports as "not found".

**Read-only (always run, no approval):**

| Tool | What it does |
|---|---|
| `read` | Read a note's contents. |
| `ls` | List a folder. |
| `find` | Find notes by glob or substring path match. |
| `grep` | Search note contents (with an early-break match cap). |
| `get_active_note` | Read the note currently open in the editor. |
| `get_backlinks` | List notes linking *to* a note. |
| `get_links` | List a note's outbound resolved links. |
| `local_graph` | A note's immediate neighborhood — inbound (backlinks) and outbound notes. |
| `get_properties` | Read a note's YAML frontmatter as structured data. |
| `recall` | Read the full durable memory store (facts + instructions). |

**Mutating (gated by the approval policy):**

| Tool | What it does |
|---|---|
| `write` | Create or overwrite a note. |
| `edit` | Exact-string replacements within a note. |
| `set_properties` | Write YAML frontmatter via Obsidian's API (won't corrupt the body). |
| `rename` | Rename or move a note — **inbound wikilinks and backlinks are updated automatically**. |
| `delete` | Move a note to trash. |
| `remember` | Append a fact or instruction to durable memory (follows your mutating-tool gate). |

The graph (`get_backlinks` / `get_links` / `local_graph`), frontmatter (`get_properties` / `set_properties`), and link-aware `rename` tools are Obsidian-native: they let the agent traverse the `[[wikilink]]` graph and edit structured metadata reliably instead of brute-grepping or hand-editing raw YAML.

## Durable memory

A persisted set of facts and instructions the agent carries across **every** conversation — a place for standing preferences ("answer terse"), project context ("Project X lives in `Projects/`"), or anything you want it to remember.

- **Author it yourself.** Edit the *Durable memory* box under **Settings → Agent**, one fact per line. It's sent as part of the system prompt, so keep it concise.
- **Or let the agent grow it.** The `remember` tool appends a fact (gated like any mutating tool — ask/allow/deny — so you stay in control), and `recall` reads the whole store back. The agent is told the memory is standing context and should honor it unless the current task overrides it.
- **Where it lives.** Per-vault, in this plugin's `data.json` — no Node `fs`, so it works on mobile and travels with the vault's plugin config.

## Subagents

For multi-part work, the agent can **delegate** to focused child agents instead of doing everything in one context:

- **Profiles.** A subagent is a profile — `{ name, description, systemPrompt, model?, toolAllowlist }` — authored as an `AGENT.md` file (YAML frontmatter + body) in a settings-configured vault folder. There's a built-in roster (researcher / reviewer / editor), and a vault profile overrides a built-in of the same name.
- **Dispatch.** The agent calls one `subagent` tool, either single (`{ agent, task }`) or parallel (`{ tasks: [...], concurrency? }`). Each child runs with its own context window, the profile's model (falling back to the parent's), and **only** the tools in its allowlist — so a research fan-out that can't write never prompts you.
- **Approval.** The *dispatch* is the approval boundary: in read-only/plan mode children are forced read-only (free); otherwise a dispatch that *can* mutate follows your `approval.mutating` policy (ask once / allow / deny). Inside a child, allowlisted tools auto-run — no per-call modal storm under parallel fan-out. Children never receive the `subagent` tool, so delegation depth is capped at one (no grandchildren).
- **UI & cost.** Each dispatch renders as a step card listing every child with live status (running / done / failed); click a row to expand that child's summary. Child token/USD usage is summed into the conversation total.

Invoke directly with `/agent <name> <task>`, or `/agent` with no argument to pick from a list. The model can also fan out on its own when a task benefits from parallel, isolated subtasks.

> **Note:** child steps are live-only. While a dispatch runs you can expand the per-child tree; what persists when you reopen the session is the summary text, not replayable child steps — the honest cost of context isolation.

## Skills

Skills are reusable instruction/capability units in the [agentskills.io](https://agentskills.io) `SKILL.md` format:

- **Where they come from.** Drop `SKILL.md` files into the vault folder set in settings. They're listed to the model with **only** their name + description (progressive disclosure); the full body is loaded only when a skill is invoked.
- **How to run them.** `/skill <name> [args]`, or directly as `/<name>` (built-in commands win a name collision; the skill stays reachable via `/skill <name>`). Auto-loaded skills appear in the `/` autocomplete popup.
- **Arguments.** A skill body can use `$ARGUMENTS` (all args) or `$1`, `$2`, … (positional). This absorbs the old "prompt template" concept — a template is just a skill that takes arguments. `/template` still works as a deprecated alias for `/skill`.

## Web access & research

Off by default. Enable *Web access* in settings (it carries an egress warning) to register two read-only tools and a research skill:

- **`web_search`** — queries your configured backend (Tavily / Brave / SearXNG; keyed in settings) and returns ranked title/URL/snippet results.
- **`fetch_url`** — fetches an http(s) page and returns readable text (scripts/markup stripped, entities decoded). A best-effort SSRF guard blocks non-http(s) schemes and localhost/private/link-local hosts.
- **`/deep-research`** — a built-in skill (advertised only while web access is on) that runs a plan → search → read → synthesize → **cite** → save loop and writes a sourced note, requiring inline source links plus a `## Sources` list.

Egress is gated by a single off-by-default setting: while it's off, the web tools aren't registered at all, so nothing can leave your device for the web. When on, search queries and fetched URLs go to your chosen search provider and the fetched sites — **outside** the model-provider privacy boundary.

## Disclosures

In the interest of transparency (and the [Obsidian Developer Policies](https://docs.obsidian.md/Developer+policies)):

- **Network use.** When the provider is OpenRouter, your prompt — including any note content you attach or the agent reads, plus tool results — is sent to OpenRouter and the model provider it routes to, subject to the privacy constraints above. With Ollama, requests go only to your configured local server. **Web access** is a separate, off-by-default opt-in: when enabled, search queries and the URLs the agent opens are sent to your chosen search provider (Tavily/Brave/SearXNG) and the fetched sites — outside the model-provider privacy boundary.
- **Account & payment.** OpenRouter requires your own account and API key, and hosted models are billed by OpenRouter to that account. The plugin itself is free and takes no payment. Ollama needs no account and is free.
- **File access.** The agent reads and modifies files in your vault through Obsidian's vault API, only when you prompt it. Mutating actions are gated by the approval policy; deletes move files to trash. Files matched by your ignore list are never exposed to the agent.
- **Telemetry.** None. No analytics, no tracking, no background network calls.
- **Source.** Fully open source under the MIT license.

## Install

### From Obsidian community plugins (recommended)

The plugin is listed in the official community directory. Open *Settings → Community plugins* (disable **Restricted mode** if prompted) → **Browse**, search for **Agentic Chat**, and install + enable it. This is the simplest path and keeps you on official releases with automatic updates.

### Via BRAT

For pre-release builds not yet in the community directory, install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then add `tardigrde/obsidian-agentic-chat` as a beta plugin. BRAT installs and updates from GitHub releases.

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

The settings page is organized into virtual tabs (General / Models / Privacy / Web / Skills & Agents / Advanced) so it isn't one long scroll.

Then click the chat ribbon icon, or run *Agentic Chat: Open chat*.

## Usage

- **Send a message.** Type and press Enter (Shift+Enter for a newline). Type `/` for commands and skills or `@` to attach a note — both show an inline autocomplete dropdown.
- **Context attachments.** The note you're viewing is **auto-attached** as a removable chip (dismiss it to suppress for the session; `/new` resets it). Add more with `@<note>`, **+ Folder** (attaches a folder listing), or by **dragging** a note/folder from the file explorer onto the composer.
- **Watch the agent work.** Each tool call is a step card you can expand to see arguments and results, with elapsed timing.
- **Approve changes.** When a mutating tool is gated by "ask", a dialog shows the exact arguments **and a diff** of the change — **Allow** (Enter) or **Deny** (Escape), with an optional "don't ask again for this tool." Flip the composer to **YOLO** to auto-approve for the session, or use `/plan` to lock to read-only.
- **Undo.** `/undo` reverts the agent's last vault change.
- **Edit & retry.** Click a sent message to load it back into the composer; sending rewinds the conversation to that point and regenerates. Every answer has copy and retry buttons. Up/Down arrows cycle your sent-message history.
- **Switch models.** Click the model pill, or `/model`. Shift-click / Shift-Enter in the picker applies a model for the **next prompt only** (shown with a "next only" badge), then auto-reverts.
- **Slash commands** run locally and are **not** sent to the model. Informational ones (`/help`, `/status`, `/usage`) render as a collapsible in-pane block.

### Slash commands

| Command | What it does |
|---|---|
| `/new` | Start a new conversation. |
| `/sessions` (`/history`) | Browse, search, reopen, rename, or delete past conversations. |
| `/model` | Switch model (Shift = next-prompt-only override). |
| `/config` (`/mode`) | Switch permission mode (Safe / YOLO). |
| `/add-dir [folder]` | Grant a working directory (auto-run inside, ask outside); no arg = folder picker. |
| `/dirs` | List / revoke granted working directories. |
| `/plan` … `/endplan` | Enter / leave sticky read-only plan mode. |
| `/style [name]` | Switch output style (default / brainstorm / learning). |
| `/skill [name] [args]` | Run a vault skill (also `/<skill-name>` directly). |
| `/agent [name] [task]` | Delegate a task to a subagent (no arg = picker). |
| `/undo` | Undo the last vault change the agent made. |
| `/status` | Show provider, model, mode, output style, session. |
| `/usage` | Show token & cost totals. |
| `/help` | List commands. |

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
npm test           # vitest (path safety, exact edits, search, routing, approval, working dirs, sessions, skills, agent service, …)
npm run typecheck  # tsc — the lint gate
npm run lint       # eslint
npm run build      # typecheck + production bundle
```

The unit suite runs without Obsidian: the `obsidian` package is replaced by a minimal mock via a vitest alias, the model stream by an injected `streamFn`, and the session store by an in-memory adapter. See `AGENTS.md` for architecture notes, and `ROADMAP.md` for planned work.

### End-to-end tests (local only)

A base end-to-end suite drives the plugin inside a **real Obsidian** instance via
[`wdio-obsidian-service`](https://github.com/jesse-r-s-hines/wdio-obsidian-service) — it
auto-downloads Obsidian, copies `test/e2e/vault` into a throwaway sandbox, loads this plugin, and
runs the smoke spec in `test/e2e/specs/`.

```bash
npm run test:e2e   # builds the plugin, then boots Obsidian and runs the smoke spec
```

It is **not** part of CI yet (it launches Electron, so it needs a display + cached Obsidian
downloads). Set `OBSIDIAN_VERSIONS` (e.g. `earliest/earliest latest/latest`) to widen the version
matrix. Unit tests (vitest) stay the fast inner loop; the e2e suite catches integration seams —
view registration, the composer card, slash-command routing, the working-dir gate — that the
mocked unit tests can't.

## Acknowledgements

- Built on the [pi](https://pi.dev) packages by Mario Zechner (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`), MIT.
- Vault tool, path-safety, exact-edit, search, and JSONL session patterns were adapted from [`lhr0909/pi-obsidian`](https://github.com/lhr0909/pi-obsidian) by Simon Liang (MIT / 0BSD).

## License

[MIT](LICENSE). See also the [third-party notices](THIRD_PARTY_NOTICES.md) for
bundled dependencies and adapted code.
