# Agentic Chat for Obsidian

A **privacy-first, agent-led AI chat** in Obsidian's right sidebar. Instead of a plain chatbot, you get an agent that *acts on your vault*: it reads, searches, writes, edits, renames, traverses links, and reads/writes frontmatter through typed tools — and every tool call is rendered inline in the chat, so you always see exactly what the agent is doing.

It runs entirely inside Obsidian on **desktop and mobile**, built on the [pi](https://pi.dev) agent packages. Use it with hosted models through [OpenRouter](https://openrouter.ai) — locked to **zero-data-retention** providers by default — or with a fully local [Ollama](https://ollama.com) server where nothing ever leaves your machine.

## Privacy first

Your notes are yours. This plugin is built so that using AI on them does not mean handing them to a model trainer.

- **Zero data retention by default.** Out of the box, OpenRouter requests are routed only to endpoints that retain nothing (`zdr: true`) *and* don't log or train on prompts (`data_collection: "deny"`). Provider fallbacks are allowed but must satisfy the **same** constraints — a fallback is never a privacy downgrade.
- **Or go fully local.** Switch the provider to Ollama and every prompt, note, and tool result stays on your device. No API key, no network, no cost.
- **No telemetry.** The plugin collects nothing, phones home to nothing, and ships no analytics. The only network traffic is the model request you trigger, to the provider you chose.
- **You see everything the agent does.** Every read, search, write, edit, rename, and delete is a visible tool call in the timeline. Mutating actions are gated by an approval policy (default: **ask**), the approval dialog shows a **diff** of the pending change, and deletes go to trash.
- **Your secrets stay local.** Provider API keys, web-search keys, MCP auth headers, and OAuth tokens are stored with Obsidian secret storage. The plugin's vault `data.json` keeps only secret IDs and non-secret settings.

> With the strict zero-data-retention default, some models may have no compliant provider on OpenRouter. If a request can't be routed, pick a different model in settings, relax the privacy toggles deliberately, or use Ollama.

## Features

- **Native sidebar chat** — an Obsidian `ItemView` styled with theme variables (light and dark just work). Tool calls appear as live step cards with elapsed-time timing; reasoning tokens stream into a collapsible section; answers render with Obsidian-style Markdown, including callouts and Mermaid diagrams; an animated indicator shows while the agent is working.
- **Inline clarification prompts** — when the agent needs a missing detail, it can call `ask_user`; the turn pauses on an inline question with optional answer buttons, then continues from your answer.
- **Vault tools** — the agent reads and acts on your vault through typed, path-safe tools (see [Vault tools](#vault-tools) for the full list): read/write/edit notes, list/search, traverse backlinks and the local graph, read/write frontmatter as structured data, rename (backlinks preserved), and delete (to trash).
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
- **Standing instructions (AGENTS.md)** — the agent loads `AGENTS.md` from your vault root (or `CLAUDE.md` / `GEMINI.md` if absent) as standing context on every turn, so the same facts and conventions persist across every conversation. Edit the file yourself, or run `/init` to have the agent curate it surgically (each edit shown as a diff). See [Standing instructions](#standing-instructions-agentsmd).
- **Web access (opt-in)** — off by default. Turn on *Web access* in settings to give the agent `web_search` (Tavily / Brave / SearXNG backend) and `fetch_url`, plus a built-in `/deep-research` skill. Egress-gated: while it's off the tools aren't registered, so nothing leaves your device for the web. See [Web access & research](#web-access--research).
- **MCP tools (opt-in)** — add your own HTTPS Streamable HTTP MCP servers in settings, with no bundled presets. Bearer-token, static-header, and OAuth auth are supported. Discovered remote tools are exposed as `mcp__server__tool`, flow through the approval gate, and return capped text into the model context. No stdio/subprocess transport. See [MCP tools](#mcp-tools).
- **Composer power tools** — a single unified input card holds the context chips, the textarea, and the bottom toolbar (model · effort · context · folders · Safe↔YOLO), with the session tabs and history/new-chat actions as a nav row above it. Plus inline autocomplete (`/` commands & skills, `@` note mentions, including `@note#heading` / `@note^block` slices), the active note auto-attached as a removable chip (ignored notes are skipped), drag-and-drop or right-click a note/folder/selection to attach it, copy/retry buttons on every answer, prompt editing (click a sent message to rewind), shell-style up/down command history, a model pill with a per-request model override, and a settings page split into virtual tabs.

## Vault tools

All paths are vault-relative; absolute paths and `..` escapes are rejected, and any path matched by your [ignore list](#features) reports as "not found".

**Read-only (always run, no approval):**

| Tool | What it does |
|---|---|
| `read` | Read a note's contents. |
| `ls` | List a folder. |
| `search` | Search note paths and note contents (with result caps and optional folder scope). |
| `get_active_note` | Read the note currently open in the editor. |
| `local_graph` | A note's immediate neighborhood — inbound (backlinks) and outbound notes. |
| `get_properties` | Read a note's YAML frontmatter as structured data. |

**Mutating (gated by the approval policy):**

| Tool | What it does |
|---|---|
| `write` | Create or overwrite a note. |
| `edit` | Exact-string replacements within a note. |
| `set_properties` | Write YAML frontmatter via Obsidian's API (won't corrupt the body). |
| `rename` | Rename or move a note — **inbound wikilinks and backlinks are updated automatically**. |
| `delete` | Move a note to trash. |

The `search` meta-tool keeps path and content search behind one model-facing decision surface; the older `find` and `grep` tools remain compatibility implementations for tests/internal surfaces. The graph (`local_graph`), frontmatter (`get_properties` / `set_properties`), and link-aware `rename` tools are Obsidian-native: they let the agent traverse the `[[wikilink]]` graph and edit structured metadata reliably instead of brute-grepping or hand-editing raw YAML. `get_backlinks` and `get_links` also remain compatibility implementations, but the default model-facing surface uses `local_graph` to avoid three overlapping graph tools.

## Standing instructions (AGENTS.md)

The agent loads a single standing-instructions file from the vault root on **every** turn and injects it into the system prompt — a place for the vault's purpose, key folders, conventions, and your preferences. It's the standard `AGENTS.md` convention: portable, transparent, and synced with the vault.

- **Which file.** `AGENTS.md` is read first; if absent, `CLAUDE.md`, then `GEMINI.md`. Symlink one to another so several agents (Claude Code, Gemini CLI, this plugin) share one source of truth.
- **Author it yourself.** Create `AGENTS.md` at the vault root and write what the agent should always know. Keep it concise — it's part of every request.
- **Or let the agent curate it.** `/init` asks the agent to read the vault structure and the current file, then make **surgical** edits to refine it (each shown as a diff for you to accept/reject; `write` is used only when creating the file). Edits go through the normal approval gate and are undoable with `/undo`.
- **Living instructions.** Because it's a regular vault file, the agent (or you) can keep editing it mid-session with the standard `edit`/`write` tools — the next turn picks up the change.

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
- **`fetch_url`** — fetches an http(s) page and returns readable text (scripts/markup stripped, entities decoded). Long pages can be paged with `offset` / `nextOffset`. A best-effort SSRF guard blocks non-http(s) schemes and localhost/private/link-local hosts.
- **`/deep-research`** — a built-in skill (advertised only while web access is on) that runs a plan → search → read → synthesize → **cite** → save loop and writes a sourced note, requiring inline source links plus a `## Sources` list.

Egress is gated by a single off-by-default setting: while it's off, the web tools aren't registered at all, so nothing can leave your device for the web. When on, search queries and fetched URLs go to your chosen search provider and the fetched sites — **outside** the model-provider privacy boundary.

## MCP tools

Off by default. Enable *MCP* in settings to discover tools from remote MCP servers over HTTPS Streamable HTTP.

- **Transport.** HTTPS only. `stdio`, subprocesses, and insecure `http://` endpoints are intentionally unsupported, so the feature stays mobile-safe and cannot spawn local processes.
- **Setup.** Use **Add server**, paste the server's HTTPS endpoint, choose auth, then **Test connection** or **Authenticate & test** to discover tools. New installs include no servers or presets.
- **Authentication.** Generic servers can use no auth, a bearer token, a custom static header, or MCP OAuth. Bearer/static-header secrets and OAuth tokens are stored with Obsidian secret storage.
- **Tool naming.** Remote tools are exposed as `mcp__<server-id>__<tool-name>` so model tool names are stable and collision-free.
- **Approval.** Every MCP server has its own allow / ask / deny policy, defaulting to **ask**. Remote tool annotations are not trusted as a safety boundary.
- **OAuth.** MCP OAuth servers use protected-resource discovery, authorization-server discovery, PKCE, dynamic client registration when available, bearer tokens, refresh tokens, and a re-auth/forget-token flow. OAuth sign-in uses a localhost callback, so sign-in currently requires Obsidian desktop. After sign-in, settings immediately probes tool discovery so a successful login also confirms the server is usable.
- **Proxy support.** Plugin-owned HTTP proxy settings use Obsidian desktop's Node networking path when configured. On mobile, leave the plugin proxy fields empty and use the device/VPN/network-level routing instead.
- **Auth storage.** Bearer tokens, static auth header values, and OAuth tokens are stored with Obsidian secret storage. The vault `data.json` stores only secret IDs plus non-secret MCP metadata.
- **Failure behavior.** MCP discovery, sign-in, token refresh, and tool calls have bounded timeouts, retry OAuth refresh once on rejected tokens, retry refresh with server-advertised scopes on `insufficient_scope`, downgrade the MCP protocol version when initialization rejects the newest advertised version, reopen a Streamable HTTP session once if the server reports that the session expired, and make bounded `Last-Event-ID` resume attempts when SSE delivery ends before the matching JSON-RPC result. If a request is accepted asynchronously (`202`), the client opens the server's SSE stream and waits for the matching result. Each configured server also has a **Test connection** action in settings that lists tools through the same MCP client path used at runtime; runtime diagnostics include per-server URL/auth/token state and categorized discovery errors.
- **Context control.** MCP text results above the inline budget are stored once as plugin-managed artifacts and the model receives a short preview plus an artifact id. The read-only `read_artifact` and `search_artifact` tools let the model inspect large results in chunks without re-running the remote MCP call. Artifacts are automatically pruned by age/count so plugin storage does not grow without bound. Image/resource payloads are summarized or omitted instead of being dumped raw.

Current limits: tool calls only; MCP resources/prompts/roots/sampling, mobile OAuth redirects, long-lived background MCP event consumers, and rich binary/resource rendering are future work tracked in the roadmap.

## Disclosures

In the interest of transparency (and the [Obsidian Developer Policies](https://docs.obsidian.md/Developer+policies)):

- **Network use.** When the provider is OpenRouter, your prompt — including any note content you attach or the agent reads, plus tool results — is sent to OpenRouter and the model provider it routes to, subject to the privacy constraints above. With Ollama, requests go only to your configured local server. **Web access** is a separate, off-by-default opt-in: when enabled, search queries and the URLs the agent opens are sent to your chosen search provider (Tavily/Brave/SearXNG) and the fetched sites — outside the model-provider privacy boundary. **MCP** is also opt-in: when enabled, MCP tool arguments are sent to the HTTPS MCP servers you configure.
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

For any OpenAI-compatible gateway, set the provider to **OpenAI-compatible**. The **Gateway preset** shortcut fills common base URLs for OpenWebUI, LM Studio, vLLM, llama.cpp, Chutes, and Venice.ai; the transport stays generic, so custom gateways still work by editing the Base URL and Model fields directly.

The settings page is organized into virtual tabs (Models / Agent / Approval / Web / MCP / Notifications / Resources) so it isn't one long scroll.

Behind a corporate proxy on desktop, set **Models → Network proxy → HTTP proxy** to an HTTP proxy URL such as `http://host:port`. Plugin-owned OpenRouter/OpenAI-compatible chat requests, model browsing, web tools, and MCP inherit it. The MCP tab has its own optional override; leave it empty unless a server needs different routing. On mobile, keep the plugin proxy fields empty and use the device/VPN/network-level proxy path instead.

Then click the chat ribbon icon, or run *Agentic Chat: Open chat*.

## Usage

- **Send a message.** Type and press Enter (Shift+Enter for a newline). Type `/` for commands and skills or `@` to attach a note — both show an inline autocomplete dropdown.
- **Context attachments.** The note you're viewing is **auto-attached** as a removable chip (dismiss it to suppress for the session; `/new` resets it). Ignore-listed notes are not auto-attached. Add more with `@<note>`, `@<note>#<heading>`, `@<note>^<block-id>`, **+ Folder** (attaches a folder listing), by **dragging** a note/folder from the file explorer onto the composer, or from Obsidian context menus: right-click a note/folder or selected editor text and send it to Agentic Chat.
- **Watch the agent work.** Each tool call is a step card you can expand to see arguments and results, with elapsed timing. Streaming output stays pinned only while you're already at the bottom; scroll up and it will stop yanking the transcript until you return.
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
| `/status` | Show provider, model, mode, output style, session, MCP servers/tools. |
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

The unit suite runs without Obsidian: the `obsidian` package is replaced by a minimal mock via a vitest alias, the model stream by an injected `streamFn`, and the session store by an in-memory adapter. See `AGENTS.md` for architecture notes and `ROADMAP.md` for planned work.

### End-to-end tests (local only)

A base end-to-end suite drives the plugin inside a **real Obsidian** instance via
[`wdio-obsidian-service`](https://github.com/jesse-r-s-hines/wdio-obsidian-service) — it
auto-downloads Obsidian, copies `test/e2e/vault` into a throwaway sandbox, loads this plugin, and
runs the specs in `test/e2e/specs/`. The no-token specs cover Obsidian boot, chat UI wiring,
session persistence, deterministic approval/write/edit/undo flows, settings UI persistence, and
existing `data.json` migration.

```bash
npm run test:e2e   # builds the plugin, then boots Obsidian and runs the local e2e suite
npm run test:e2e -- --spec test/e2e/specs/smoke.e2e.ts
npm run test:e2e:mobile
npm run test:e2e:matrix -- --spec test/e2e/specs/smoke.e2e.ts
npm run verify:mobile
```

It is **not** part of CI yet (it launches Electron, so it needs a display + cached Obsidian
downloads). `npm run test:e2e` intentionally runs one Obsidian version at a time; set
`OBSIDIAN_VERSIONS=earliest/earliest` or another single pair for a targeted run. Use
`npm run test:e2e:matrix` for supported-version coverage; it runs sequentially across
`OBSIDIAN_VERSION_MATRIX` or, by default, `earliest/earliest,latest/latest`. Unit tests (vitest)
stay the fast inner loop; the e2e suite catches integration seams — view registration, settings
tabs, persistence/migration, composer wiring, slash-command routing, and approval gates — that the
mocked unit tests can't.

`npm run verify:mobile` is part of `npm run build` and blocks direct Node/Electron
API usage outside documented desktop-only fallbacks. `npm run test:e2e:mobile`
builds the e2e bundle, enables `wdio-obsidian-service` mobile emulation, applies
Chrome phone-sized device metrics, and runs a WDIO smoke to catch mobile layout
regressions. Real Obsidian Mobile still needs the Android/iOS checklist in
[MOBILE_TESTING.md](MOBILE_TESTING.md).

Live model-backed e2e specs are opt-in and skip unless their keys are present.
Use `OPENROUTER_API_KEY` for the OpenRouter guardrail flow, or
`OPENWEBUI_API_KEY` / `OPENWEBUI_API_KEY_FILE` with `OPENWEBUI_BASE_URL` and
`OPENWEBUI_MODEL` for an OpenAI-compatible gateway flow. When running behind a
corporate proxy, keep `NO_PROXY=localhost,127.0.0.1,::1`; the WDIO config keeps
chromedriver local and passes a normalized proxy setting to Obsidian/Electron.
When provider transport, model settings, proxy handling, or request formatting
changes, run `npm run verify:provider-live`; unlike the default e2e command, it
requires live credentials and fails instead of accepting skipped provider specs.

Live MCP e2e is also opt-in and refuses insecure endpoints:

```bash
AGENTIC_CHAT_E2E_MCP_URL=https://mcp.example.com/mcp \
AGENTIC_CHAT_E2E_MCP_TOOL=tool-name \
AGENTIC_CHAT_E2E_MCP_ARGS_JSON='{"input":"value"}' \
npm run test:e2e -- --spec test/e2e/specs/mcp-live.e2e.ts
```

For static-header servers, also set `AGENTIC_CHAT_E2E_MCP_HEADER_NAME` and
`AGENTIC_CHAT_E2E_MCP_HEADER_VALUE`.

## Acknowledgements

- Built on the [pi](https://pi.dev) packages by Mario Zechner (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`), MIT.
- Vault tool, path-safety, exact-edit, search, and JSONL session patterns were adapted from [`lhr0909/pi-obsidian`](https://github.com/lhr0909/pi-obsidian) by Simon Liang (MIT / 0BSD).

## License

[MIT](LICENSE). See also the [third-party notices](THIRD_PARTY_NOTICES.md) for
bundled dependencies and adapted code.
