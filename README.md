# Agentic Chat for Obsidian

> **Experimental.** APIs, settings, and behavior change often. Pin a version if you need stability.

**Compatibility:** Agentic Chat requires Obsidian 1.13.0 or later on desktop and
mobile. The minimum rises with the Obsidian APIs the plugin uses; older app
versions are not supported.

Agentic Chat is an AI chat panel in the Obsidian right sidebar. The agent reads, searches, writes, edits, renames, and moves notes, follows links, and reads or writes frontmatter through typed tools. Each tool call appears inline in the chat, so you can see what the agent does.

It runs in Obsidian on desktop and mobile and uses the [pi](https://pi.dev) agent packages. You can use hosted models through [OpenRouter](https://openrouter.ai), with zero-data-retention routing on by default, or a local [Ollama](https://ollama.com) server that keeps requests on your machine.

## Documentation

User and maintainer docs: [tardigrde.github.io/obsidian-agentic-chat](https://tardigrde.github.io/obsidian-agentic-chat/).

Local docs commands:

```bash
npm run docs:dev
npm run docs:build
npm run docs:preview
```

## Privacy

Privacy controls are on by default.

- **OpenRouter routing.** By default, requests go only to endpoints with zero data retention (`zdr: true`) and a no-logging, no-training policy (`data_collection: "deny"`). Fallbacks must meet both rules. See [How privacy routing works](#how-privacy-routing-works).
- **Local models.** A local Ollama server keeps prompts, notes, and tool results on your machine.
- **No telemetry.** The plugin has no analytics endpoint and sends no telemetry. It fetches OpenRouter's public model catalog to update local pricing data when the cache is missing or older than three days. That request contains no vault content. Apart from that request and the model calls you make, network traffic comes from features you enable.
- **Visible tool calls.** Every tool call appears in the timeline. Mutating tools use the approval policy (default: ask). The dialog shows a diff, and deletes go to trash when available.
- **Secrets.** Provider keys, web-search keys, MCP auth headers, and OAuth tokens are stored in Obsidian secret storage. The vault `data.json` stores only secret IDs and non-secret settings.

> With strict zero-data-retention routing, some models may have no compliant provider on OpenRouter. Choose another model, relax the privacy settings on purpose, or use Ollama.

## Features

- **Sidebar chat.** An Obsidian `ItemView` that uses theme variables. It streams answers, shows tool calls as live step cards with elapsed time, puts reasoning tokens in a collapsible section, and renders Markdown with callouts and Mermaid diagrams.
- **Inline questions.** The `ask_user` tool pauses a turn on an inline question with optional answer buttons. The turn continues with your answer.
- **Vault tools.** Typed, path-safe tools read, write, edit, list, search, follow links, read and write frontmatter, rename with backlink updates, and delete to trash. See [Vault tools](#vault-tools).
- **Approval gates.** Read-only tools run without approval. Mutating tools use allow / ask / deny, set globally or per tool. Ask shows the arguments and a line-level diff. You can remember the choice for that tool.
- **Undo.** `/undo` reverts the last vault change: write, edit, rename, frontmatter update, single-file delete, or empty-folder delete. A recursive delete of a non-empty folder cannot be reverted.
- **Safe and YOLO modes.** The composer switch sets the approval posture. Safe uses your policy. YOLO auto-approves mutating tools for the session, except recursive folder deletes; a per-tool deny still wins.
- **Ignore list.** Gitignore-style globs such as `Private/`, `*.secret.md`, and `**/diary/**` hide notes from the agent. Matching files report as not found to every tool, so the agent cannot read, list, search, or edit them.
- **Sessions.** Each chat is stored as JSONL in the plugin folder and resumes on reload. Browse, search, reopen, rename, delete, export, or clear sessions. Titles come from the first prompt. Sessions work on mobile without SQLite or Node `fs`.
- **Token and cost control.** Per-message and per-session token and USD usage (`/usage`, `/status`), a next-request cost estimate, a cost alert, a spend cap that blocks or aborts at the limit, and a context-window bar. Long sessions compact older turns into a summary before overflow; `/compact [instructions]` runs compaction on demand.
- **Memory.** Long-term memories (`preference`, `fact`, `instruction`, `summary`) at global or vault scope. Add, review, export, or clear them with `/memory`. The agent retrieves them only through `search_memory`.
- **Semantic search (opt-in).** A scoped vector index over notes, with OpenRouter, Ollama, or OpenAI-compatible embeddings. `/semantic-index` estimates, starts, cancels, or reports the index. A full-vault build requires `/semantic-index start vault --confirm-vault`.
- **Document import.** `import_pdf` and `import_document` extract text from PDF, EPUB, DOCX, PPTX, and XLSX files into source artifacts with citation anchors. `read_artifact` and `search_artifact` inspect the chunks.
- **Composer paths.** While the agent is idle, Enter sends. While it responds, Enter steers after the next successful tool call, Shift+Enter inserts a newline, **Queue** holds the draft until the turn ends, and **Stop** then send replaces the turn. `/effort` sets reasoning effort.
- **Observability (opt-in).** Send OTLP/HTTP traces to Langfuse or a generic OTLP endpoint. Metadata mode is the default and excludes prompts, note bodies, tool args, and tool results. See [Observability](#observability).
- **Subagents.** The agent can delegate a focused task to a child with its own context window, model, and tool subset. The only built-in role is Explorer (read-only recon). Custom roles need a code change. Run `/agent <name> <task>`. See [Subagents](#subagents).
- **Skills.** Agent plugin packages in `.agentic-plugins/` provide `SKILL.md` skills, next to built-in skills. The model sees only name and description until a skill is invoked. Run `/skill <name>` or `/<name>`. A body can use `$ARGUMENTS` or `$1`. `/doctor` audits plugin packages. See [Skills](#skills).
- **Output styles.** `/style` switches the assistant style: default, brainstorm, or learning.
- **Standing instructions.** The agent loads `AGENTS.md` from the vault root on every turn, or `CLAUDE.md` / `GEMINI.md` if absent. Use `/init [instructions]` to curate the file. See [Standing instructions](#standing-instructions-agentsmd).
- **Web access (opt-in).** Off by default. When enabled, it adds `web_search` (Tavily, Brave, or SearXNG), `fetch_url`, and `/deep-research`. While it is off, the tools are not registered and no web-access request is made. The plugin still refreshes its OpenRouter pricing cache when that cache is missing or older than three days. See [Web access & research](#web-access--research).
- **MCP tools (opt-in).** Add HTTPS Streamable HTTP MCP servers, plus plain HTTP for loopback servers. Bearer, static-header, and OAuth auth are supported. Tools appear as `mcp__server__tool` and pass through the approval gate. No stdio transport. See [MCP tools](#mcp-tools).
- **Composer.** One input card holds context chips, the textarea, and the toolbar (model, effort, context, folders, Safe/YOLO). Session tabs and history/new-chat actions sit above it. Inline autocomplete handles `/` commands and skills plus `@` note mentions, including `@note#heading` and `@note^block`. The active note is attached as a removable chip. Drag and drop or right-click a note, folder, or selection to attach it. Answers have copy and retry buttons. Click a sent message to edit and rewind. Up/Down cycles command history. The model pill allows a per-request override.

## Vault tools

All paths are vault-relative. The plugin rejects absolute paths and `..` escapes. Ignored paths report as not found.

**Read-only (no approval):**

| Tool | What it does |
|---|---|
| `read` | Read a note. Use `startLine`/`endLine` or byte `offset`/`limit` for a bounded read. |
| `vault_inspect` | Read-only meta-tool. `action=list` lists a folder, `search` searches names and contents, `active_note` reads the open note, `local_graph` shows inbound and outbound links, and `properties` reads YAML frontmatter. |

**Mutating (approval gate):**

| Tool | What it does |
|---|---|
| `write` | Create or overwrite a note. |
| `edit` | Replace exact strings in a note. |
| `set_properties` | Write YAML frontmatter through Obsidian's API. |
| `rename` | Rename or move a note and update inbound wikilinks. |
| `delete` | Move a note or folder to trash. A non-empty folder needs `recursive:true`, which asks even in YOLO unless `delete` is set to allow. |

`vault_inspect` is the default model-facing tool for list, search, active note, graph, and frontmatter reads. The older `ls`, `search`, `find`, `grep`, `get_active_note`, `get_backlinks`, `get_links`, `local_graph`, and `get_properties` tools are compatibility-only and are not sent to the model by default. There is no settings toggle for them.

## Standing instructions (AGENTS.md)

The agent loads one standing-instructions file from the vault root on every turn and adds it to the system prompt. Use it for the vault's purpose, key folders, conventions, and your preferences.

- **Which file.** `AGENTS.md` is read first, then `CLAUDE.md`, then `GEMINI.md`. Symlink them if several agents should share one file.
- **Author it yourself.** Keep it short because it goes into every request.
- **Or let the agent curate it.** `/init [instructions]` asks the agent to read the vault and the current file, then make small edits. Each edit shows a diff. `write` is used only to create the file. Edits use the normal approval gate and `/undo`.
- **Implicit context.** The file is always included when present. Opening it at the vault root does not add an active-note chip.
- **Editable file.** It is a normal vault file, so you or the agent can edit it during a session. The next turn uses the new content.

## Subagents

The agent can delegate a focused task to a child agent with its own context window, the role's model (or the parent's), and only the tools in its allowlist. Each child has an isolated context. It is not a different persona.

- **Roles.** The only built-in role is Explorer, which does read-only recon. Custom roles are not supported; add them in code.
- **Dispatch.** The agent calls `subagent` once per child (`{ agent, task }`). Several calls in one message run concurrently, with a cap. Children never get the `subagent` tool, so depth is one level.
- **Approval.** Each child tool call still passes through the parent approval gate.
- **UI and cost.** A dispatch shows a step card with each child's live status. Click a row to expand the summary. Child token and USD usage is added to the conversation total.

Run `/agent <name> <task>`, or `/agent` to choose from a list. The model can also dispatch children on its own.

Child steps are live only. After you reopen a session, the summary text remains but the child steps cannot be replayed.

## Skills

Skills use the [agentskills.io](https://agentskills.io) `SKILL.md` format.

- **Source.** Agent Plugins 1.0.0 packages in `.agentic-plugins/` provide `skills/<name>/SKILL.md`, next to built-in skills. Plugin skills load first and win a name collision. The model sees only the name and description until a skill is invoked.
- **Run.** `/skill <name> [args]`, or `/<name>` when no built-in command has that name.
- **Arguments.** A body can use `$ARGUMENTS` or `$1`, `$2`, and so on.
- **Audit.** `/doctor` checks each package against the Agent Plugins 1.0.0 spec and reports skills, MCP servers, and violations.

## Web access & research

Off by default. Enable Web access in settings to register two read-only tools and the `/deep-research` skill. The setting shows an egress warning.

- **`web_search`** queries Tavily, Brave, or SearXNG and returns ranked title, URL, and snippet results. Results are wrapped as untrusted data.
- **`fetch_url`** fetches an HTTP(S) page and returns readable text. Scripts and markup are stripped and entities decoded. Long pages can be paged with `offset` and `nextOffset`. A best-effort SSRF guard blocks non-HTTP(S) schemes and localhost, private, and link-local hosts. A Fetch allowlist restricts destinations to matching hosts (`*.example.com`, `example.com`, or `*`), checked on every redirect hop. Output is wrapped in `[BEGIN_UNTRUSTED_TOOL_OUTPUT ...]` markers.
- **`/deep-research`** is a built-in skill that runs parallel Explorer subagents, adds an adversarial review, then writes a sourced note with a `## Sources` list.

While Web access is off, the tools are not registered. When it is on, search queries and fetched URLs leave the model-provider boundary and go to your search provider and the fetched sites. The allowlist limits which hosts the tool can reach.

## MCP tools

Off by default. Enable MCP in settings to discover tools from remote MCP servers.

- **Transport.** HTTPS Streamable HTTP for remote servers; plain HTTP only for loopback servers. There is no stdio or subprocess transport, so the plugin cannot spawn local processes and stays mobile-safe.
- **Setup.** On the Advanced tab under MCP tools, **Add MCP server** writes an agent plugin package (`plugin.json` + `mcp.json`) for the endpoint. Packages own endpoints after creation. Choose auth, then **Test connection** or **Authenticate & test**. New installs have no servers or presets.
- **Auth.** Servers can use no auth, a bearer token, a static header, or MCP OAuth. Bearer/static-header secrets and OAuth tokens are stored in Obsidian secret storage.
- **Names.** Remote tools appear as `mcp__<server-id>__<tool-name>`.
- **Approval.** Each server has its own allow / ask / deny policy, defaulting to ask. Remote tool annotations are not treated as a safety boundary.
- **OAuth.** The client uses protected-resource discovery, authorization-server discovery, PKCE, dynamic client registration when available, bearer and refresh tokens, and a re-auth/forget-token flow. OAuth sign-in uses a localhost callback on desktop and an `obsidian://agentic-chat-mcp-oauth` callback on mobile when the provider supports app redirects. Providers that require localhost redirects still require Obsidian desktop sign-in or bearer/static-header auth. After sign-in, settings probes tool discovery.
- **Proxy support.** Plugin-owned HTTP proxy settings use Obsidian desktop's Node networking path when configured. On mobile, leave the plugin proxy fields empty and use the device/VPN/network-level routing instead.
- **Storage.** Bearer tokens, static auth header values, and OAuth tokens are stored in Obsidian secret storage. The vault `data.json` stores only secret IDs and non-secret MCP metadata.
- **Failures.** Discovery, sign-in, token refresh, and tool calls have bounded timeouts. The client retries an OAuth refresh once, retries with server-advertised scopes on `insufficient_scope`, falls back to older protocol versions, reopens an expired Streamable HTTP session once, and makes bounded `Last-Event-ID` resume attempts. A `202` response opens the SSE stream and waits for the result. **Test connection** lists tools through the runtime client; diagnostics show per-server URL, auth state, and discovery errors.
- **Context control.** Large MCP text results become plugin-managed artifacts. The model gets a short preview and an artifact ID, then uses `read_artifact` and `search_artifact` to inspect the result without another remote call. Artifacts are pruned by age, count, and total bytes; artifacts cited by saved sessions are kept. Image and resource payloads are summarized or omitted.

MCP support covers tool calls only. Resources, prompts, roots, sampling, long-lived event consumers, and rich binary rendering are not supported.

## Observability

Off by default. Enable Observability only when you want traces at an endpoint you control.

- **Backends.** Langfuse or generic OTLP. Langfuse takes a base URL and posts OTLP/HTTP JSON to `/api/public/otel/v1/traces`; generic OTLP takes a full `/v1/traces` endpoint.
- **No default endpoint.** New installs have observability off and an empty endpoint.
- **Secrets.** Langfuse keys and OTLP auth header values use Obsidian secret storage. `data.json` keeps only secret IDs and non-secret settings.
- **Payload.** `metadata` (default) sends turn, generation, tool, and approval spans; model and provider IDs; token usage; cost; stop reason; and error class. It does not send prompts, answers, note contents, tool args, tool results, or vault paths. `Redacted text previews` adds short masked prompt and answer previews. `Full prompt/output content` sends prompt and answer text.
- **Proxy.** Observability can use its own proxy or inherit the Models proxy. On mobile, leave plugin proxy fields empty and use the device/VPN/network route.

## Disclosures

In line with the [Obsidian Developer Policies](https://docs.obsidian.md/Developer+policies):

- **Network use.** With OpenRouter, prompts, attached or read note content, and tool results go to OpenRouter and the provider it routes to, subject to the privacy settings. With Ollama, requests go to the server you configure. Web access, MCP, and Observability are opt-in and send data only when enabled. The pricing-cache request described under [Privacy](#privacy) contains no vault content.
- **Account and payment.** OpenRouter needs your account and API key, and OpenRouter bills hosted models to that account. The plugin is free and takes no payment. Ollama needs no account and is free.
- **File access.** The agent reads and changes vault files through Obsidian's vault API, only from your prompts. Mutating tools pass the approval gate. Deletes go to trash when Obsidian or the OS can trash them; if both trash paths fail, the plugin removes the file permanently. Ignored files are never exposed.
- **Telemetry.** None by default. No analytics or tracking. Observability sends data only after you enable it and set an endpoint.
- **Source.** Fully open source under the MIT license.

## Install

### From Obsidian community plugins (recommended)

The plugin is listed in the official community directory. Open *Settings → Community plugins* (disable **Restricted mode** if prompted) → **Browse**, search for **Agentic Chat**, and install and enable it. Obsidian handles updates through the community directory.

### Via BRAT

Use [BRAT](https://github.com/TfTHacker/obsidian42-brat) for pre-release builds before they reach the community directory. Install BRAT, then add `tardigrde/obsidian-agentic-chat` as a beta plugin. BRAT installs and updates from GitHub releases.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/tardigrde/obsidian-agentic-chat/releases) (or build them; see [Development](#development)).
2. Copy them into `<your vault>/.obsidian/plugins/agentic-chat/`.
3. Reload Obsidian and enable **Agentic Chat** in *Settings → Community plugins*.

## Setup

**OpenRouter (default, zero data retention):**

1. Create an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Open *Settings → Agentic Chat*, paste the key, and pick a model. **Browse** lists tool-capable models. While zero data retention is on, it shows only models with a ZDR-compliant endpoint. The default is `moonshotai/kimi-k2.6`.
3. The strict privacy defaults are on. To use a model with no ZDR provider, relax the routing settings on purpose. Browse then shows the full catalog.

**Ollama (local):**

1. Run a local Ollama server and pull a tool-capable model.
2. Set the provider to **Ollama (local)**, then set the server URL (default `http://localhost:11434`) and model tag.

For any OpenAI-compatible gateway, set the provider to **OpenAI-compatible**. The **Gateway preset** shortcut fills common base URLs for OpenWebUI, LM Studio, vLLM, llama.cpp, Chutes, and Venice.ai. The transport stays generic, so other gateways work when you edit the Base URL and Model fields.

The settings page has three tabs: Models, Agent, and Advanced. Advanced holds web access, MCP, observability, notifications, plugins, subagents, semantic retrieval, and the ignore list.

On desktop behind a corporate proxy, set **Models → Network proxy → HTTP proxy** to a URL such as `http://host:port`. Plugin-owned OpenRouter/OpenAI-compatible chat requests, model browsing, web tools, MCP, and observability use it. The MCP and observability sections on the Advanced tab have optional overrides; leave them empty unless a server needs different routing. On mobile, keep the plugin proxy fields empty and use the device/VPN/network-level proxy path.

Then click the chat ribbon icon, or run *Agentic Chat: Open chat*.

## Usage

- **Send a message.** Type and press Enter (Shift+Enter for a newline). Type `/` for commands and skills or `@` to attach a note. Both show an inline autocomplete list.
- **Context attachments.** The note you are viewing is attached as a removable chip. Dismiss it to suppress it for the session; `/new` resets it. Ignore-listed notes and root standing-instruction files are not attached. Add more with `@<note>`, `@<note>#<heading>`, `@<note>^<block-id>`, **+ Folder** (a folder listing), by dragging a note or folder from the file explorer onto the composer, or from Obsidian context menus: right-click a note, folder, or selected editor text and send it to Agentic Chat.
- **Watch the agent work.** Each tool call is a step card you can expand to see arguments, results, and elapsed time. Streaming output stays pinned only while you are at the bottom. Scroll up and the transcript stops following new output until you return to the bottom.
- **Approve changes.** When a mutating tool is set to ask, a dialog shows the arguments and a diff of the change. **Allow** (Enter) or **Deny** (Escape). You can choose "don't ask again for this tool"; the plugin remembers the final choice. Switch the composer to **YOLO** to auto-approve for the session.
- **Undo.** `/undo` reverts the agent's last vault change.
- **Edit and retry.** Click a sent message to load it back into the composer. Sending rewinds the conversation to that point and regenerates. Every answer has copy and retry buttons. Up/Down cycles your sent-message history.
- **Switch models.** Click the model pill, or use `/model`. Shift-click or Shift-Enter in the picker applies a model for the next prompt only (shown with a "next only" badge), then reverts.
- **Slash commands.** Commands run locally and are not sent to the model. Informational commands (`/help`, `/status`, `/usage`) render as a collapsible in-pane block.

### Slash commands

| Command | What it does |
|---|---|
| `/new` | Start a new conversation. |
| `/sessions` | Browse, search, reopen, rename, or delete past conversations. `clear --confirm` clears all sessions in the current scope. |
| `/model` | Switch model. Shift applies a next-prompt-only override. |
| `/effort [level]` | Set reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`). The level persists. |
| `/compact [instructions]` | Summarize older turns now. Optional text guides the summary. |
| `/init [instructions]` | Curate the vault standing-instructions file. Optional text guides the update. |
| `/style [name]` | Switch output style. |
| `/skill [name] [args]` | Run a vault skill. |
| `/<skill-name>` | Run a skill directly when no built-in command has that name. |
| `/agent [name] [task]` | Delegate a task to a subagent. Without arguments, opens a picker. |
| `/undo` | Undo the last vault change the agent made. |
| `/status` | Show provider, model, mode, output style, session, MCP servers, and tools. |
| `/usage` | Show token and cost totals. |
| `/memory [add\|review\|manage\|export\|clear]` | Add, review, export, or clear stored long-term memories. |
| `/semantic-index [status\|estimate\|start\|cancel]` | Manage scoped semantic indexing. |
| `/export` | Save this conversation as a Markdown note. |
| `/doctor` | Audit runtime health, agent plugins, and MCP configs. |
| `/help` | List commands. |

Composer delivery is not a slash command. Enter sends while idle. While the agent responds, Enter steers after the next successful tool call, Shift+Enter inserts a newline, **Queue** holds the draft until the turn ends, and **Stop** then send replaces the turn.

## How privacy routing works

Privacy settings are applied to every OpenRouter request through the provider routing options:

| Setting | Effect | Default |
|---|---|---|
| Require zero data retention | `zdr: true`: only endpoints that retain nothing | **on** |
| Deny prompt logging and training | `data_collection: "deny"` | **on** |
| Allow provider fallbacks | `allow_fallbacks: true`: fallbacks must obey the first two rules | **on** |

If no compliant provider exists for a model, choose another model, relax a setting on purpose, or use Ollama. Ollama requests go only to the server you configure.

## Development

```bash
npm install
npm run dev         # esbuild watch mode
npm run docs:dev    # VitePress docs dev server
npm test            # vitest
npm run typecheck   # TypeScript check
npm run lint        # eslint
npm run build       # typecheck, production bundle, release and mobile checks
npm run docs:build  # VitePress production docs build
```

The unit suite does not need Obsidian. The `obsidian` package is replaced by a minimal mock through a vitest alias, the model stream by an injected `streamFn`, and the session store by an in-memory adapter. `AGENTS.md` has architecture notes and `ROADMAP.md` lists planned work.

### End-to-end tests (real Obsidian)

A base end-to-end suite drives the plugin in a real Obsidian instance through [`wdio-obsidian-service`](https://github.com/jesse-r-s-hines/wdio-obsidian-service). It downloads Obsidian, copies `test/e2e/vault` into a throwaway sandbox, loads the plugin, and runs the specs in `test/e2e/specs/`. The no-token specs cover Obsidian boot, chat UI wiring, session persistence, deterministic approval/write/edit/undo flows, settings UI persistence, and `data.json` migration.

```bash
npm run test:e2e   # builds the plugin, then boots Obsidian and runs the local e2e suite
npm run test:e2e -- --spec test/e2e/specs/smoke.e2e.ts
npm run test:e2e:dogfood
npm run test:e2e:mobile
npm run test:e2e:matrix -- --spec test/e2e/specs/smoke.e2e.ts
npm run verify:mobile
```

CI runs the deterministic suite under `xvfb-run` with a cached Obsidian runtime, then the scripted dogfood eval. Locally the suite launches Electron, so it needs a display and cached Obsidian downloads. `npm run test:e2e` runs one Obsidian version at a time; set `OBSIDIAN_VERSIONS=earliest/earliest` or another single pair for a targeted run. `npm run test:e2e:matrix` covers supported versions sequentially across `OBSIDIAN_VERSION_MATRIX`, or by default `earliest/earliest,latest/latest`. Unit tests are the fast loop. E2e catches integration seams such as view registration, settings tabs, persistence and migration, composer wiring, slash-command routing, and approval gates.

`npm run test:e2e:dogfood` generates a fresh adversarial vault under `logs/dogfood-runs/<run-id>/`, installs the current plugin, drives real Obsidian through WDIO, and fails if the dogfood invariant oracle or the generated report finds a regression. It uses a deterministic scripted model by default, so it needs no live model credentials.

`npm run verify:mobile` is part of `npm run build`. It blocks direct Node/Electron API use outside documented desktop fallbacks. `npm run test:e2e:mobile` builds the e2e bundle, enables mobile emulation, applies phone-sized device metrics, and runs a WDIO smoke test for layout regressions. Real Obsidian Mobile needs the Android/iOS checklist in [MOBILE_TESTING.md](MOBILE_TESTING.md).

Live model e2e specs are opt-in and skip without keys. Set `AGENTIC_CHAT_API_KEY`, `AGENTIC_CHAT_BASE_URL`, and `AGENTIC_CHAT_MODEL` for an OpenAI-compatible gateway (OpenRouter, OpenWebUI, or a local proxy). Behind a corporate proxy, keep `NO_PROXY=localhost,127.0.0.1,::1`; the WDIO config keeps chromedriver local and passes a normalized proxy to Obsidian/Electron.

When provider transport, model settings, proxy handling, or request formatting changes, run `npm run verify:provider-live`. Unlike the default e2e command, it requires live credentials and fails instead of accepting skipped provider specs. That gate also runs `npm run eval:provider-cache-live`, which sends repeated large stable prompts through the OpenAI-compatible gateway and fails unless a warm request reports provider cache-read tokens. The cache probe accepts `OPENAI_COMPATIBLE_*` variables or the `OPENWEBUI_*` variables used by the e2e spec. To load a local dotenv file without shell-sourcing secrets, pass `npm run eval:provider-cache-live -- --env-file .env`.

Live MCP e2e is also opt-in and refuses insecure endpoints:

```bash
AGENTIC_CHAT_E2E_MCP_URL=https://mcp.example.com/mcp \
AGENTIC_CHAT_E2E_MCP_TOOL=tool-name \
AGENTIC_CHAT_E2E_MCP_ARGS_JSON='{"input":"value"}' \
npm run test:e2e -- --spec test/e2e/specs/mcp-live.e2e.ts
```

For static-header servers, also set `AGENTIC_CHAT_E2E_MCP_HEADER_NAME` and `AGENTIC_CHAT_E2E_MCP_HEADER_VALUE`.

## Acknowledgements

- Built on the [pi](https://pi.dev) packages by Mario Zechner (`@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`), MIT.
- Vault tool, path-safety, exact-edit, search, and JSONL session patterns were adapted from [`lhr0909/pi-obsidian`](https://github.com/lhr0909/pi-obsidian) by Simon Liang (MIT / 0BSD).

## License

[MIT](LICENSE). See the [third-party notices](THIRD_PARTY_NOTICES.md) for bundled dependencies and adapted code.
