# Roadmap

Direction for `agentic-chat`, the agent-led Obsidian sidebar chat. This is a living
document. It lists **only open work** — shipped features are documented in the
[README](README.md), not tracked here. Items are grouped by theme for context; the
**priority matrix at the end** is the actual ordering signal: every item carries a
**value** score (1–10, value to a general user) and an **effort** T-shirt size
(XS/S/M/L/XL). High value × small effort is what to build first.

## Guiding model

We follow Claude Code's conceptual split rather than collapsing everything into one
abstraction. **Skills**, **output styles**, **modes**, and **subagents** are *distinct*
concepts that compose — they do not fully overlap:

- **Skill** — a reusable capability/instruction unit ([agentskills.io](https://agentskills.io)
  `SKILL.md` format), loaded with progressive disclosure (name + description always visible;
  full body only on invocation). Prompt templates are absorbed here: a skill that takes
  `$ARGUMENTS` is just an invokable skill. *(Shipped.)*
- **Output style** — *how* the assistant talks (tone, structure). A system-prompt overlay,
  switched with `/style`. Built-in set: default / brainstorm / learning. *(Shipped.)*
- **Mode** — *what the agent is allowed to do*. A single **Safe ↔ YOLO** toggle (Safe = honor
  the settings approval policy; YOLO = session auto-approve all mutating). **Plan** is the
  sticky read-only `/plan` command, not a visible mode. *(Shipped.)*
- **Subagent** — a **profile** (system prompt + model + allowed tools) the agent *delegates
  to*: spawn a focused child session, run it in isolation, get back a summary. Delegation, not
  a whole-chat persona switch. *(v1 shipped; v2 below.)*

### Out of scope

- **stdio / subprocess transports on mobile.** Every integration stays networked or in-process
  so mobile keeps working: MCP is **Streamable HTTP only**, and the ACP client is
  **desktop-only** by nature. No shell/subprocess in the in-process agent.
- **MCP server role.** We are an MCP *client* only, never a server.

---

## Providers & privacy

- **Generic OpenAI-compatible provider** (`G1`). Add a third branch to `buildModel`
  (`src/llm/models.ts`) alongside OpenRouter/Ollama: endpoint + API key + privacy flags,
  modeled on the Ollama branch. Named presets — **Chutes** (TEE/confidential), **Venice.ai**,
  **LM Studio**, **vLLM**, **llama.cpp** — become settings entries, not new code branches.
  Privacy becomes config, not code.
- **Provider/preset settings UI** (`G2`). Endpoint / key / model selection per provider or
  preset. Ships with `G1`.
- **TEE/confidential model filter** (`G3`, stretch). Filter the model browser to
  TEE/confidential models, mirroring the ZDR filter, so privacy is enforced by construction.

## Vault QA & RAG

The most-requested capability across Obsidian AI plugins, and the heaviest.

- **Lexical-first Vault QA** (`R1`). A "chat with the whole vault" retrieval mode that works
  **day one** on lexical/grep ranking — no index required — then swaps in embeddings for
  relevance without changing the UX. Avoids gating QA on the heaviest part of the work.
  (Pattern from Obsidian Copilot's "Smart Vault Search.")
- **Embeddings** (`R2`). Local and OpenRouter embeddings.
- **Semantic vault search** (`R3`). Embedding-backed retrieval to replace/augment the
  brute-force `grep`/`find` path behind Vault QA. Depends on `R2`.
- **QA inline citations** (`R4`). Prompt the QA/research path to cite the exact
  `[[note#heading]]`/`^block` it drew each claim from, rendered as clickable links, so answers
  are verifiable.
- **Relevant-notes panel** (`R5`). A sidebar section that surfaces notes related to what you're
  reading/writing — no prompt — ranked by embeddings + backlink proximity (rides the existing
  graph/backlink tools). A *non-chat* delivery surface; a flagship PKM differentiator once
  embeddings land.

## Web & research

- **`fetch_url` read-more / pagination** (`W1`). Add an `offset` param so the model can fetch
  the next window of a truncated page and learn whether more remains. The char limit applies to
  the *already-extracted* text, not raw HTML (raw is pre-capped at `MAX_RAW_CHARS`).
- **Better extraction (Readability)** (`W2`). The hand-rolled regex stripper
  (`extractReadableText`) returns *all* visible text — nav, footer, cookie banners — wasting the
  char budget on boilerplate. Upgrade to Mozilla Readability via the platform `DOMParser`
  (present in the Obsidian renderer on desktop and mobile), keeping the regex path as fallback.
- **Deep-research = subagent-backed orchestration** (`W3`). Re-back the shipped `deep-research`
  skill with the subagent dispatch: a supervisor fans out parallel searcher children (isolated
  context) + adversarial verify, then synthesizes — matching open_deep_research / langchain
  deepagents / Gemini topology, instead of one flat prompt loop. Keep `/deep-research` as the
  entry point; model configurable via the research profile's `model`.

## Live interaction & in-editor editing

Make the running agent steerable and let edits happen where the cursor is. All in-process and
mobile-safe — no shell/subprocess.

- **Steering messages** (`L1`). Inject a message into a *running* turn to course-correct
  without aborting (today we only have abort). Needs pi-agent-core queued user input mid-loop +
  a send-while-running affordance. Cheapest high-impact win since we already own the pi loop.
  (pi-plugin.)
- **Message queue (type-ahead while running)** (`L2`). Messages typed during a turn stay
  editable until it ends, then send. **Design tension with steering:** a mid-run message could
  *steer now* or *queue for next* — decide a default + an explicit modifier (e.g. Enter = queue,
  Shift = steer now) before building either. (Claudian.)
- **`ask_user` clarification tool** (`L3`). A typed tool the agent calls to pause and ask a
  structured question mid-task (distinct from prose). Renders as an inline prompt; pairs with the
  approval gate and plan mode. (obsidian-chat.)
- **Inline edit / Quick Ask** (`L4`). Select text in a note (or at the cursor) + a hotkey → the
  agent rewrites **in place**, shown as a word-level diff to accept/reject, no chat round-trip.
  Strong Obsidian-native surface; reuses the shipped diff/accept UI.
  (Claudian `InlineEditModal`; Copilot "Quick Command".)
- **Plan/todo tracker panel** (`L5`). Render the agent's plan (`todo`-style steps) as a live
  `Tasks (x/y)` checklist above the transcript, not buried in tool steps. (Claudian
  `StatusPanel` — todo half only.)
- **`#` inline persistent instruction** (`L6`). Typing `#…` in the composer appends a durable
  custom instruction (lightweight "remember this") rather than sending a prompt — grows a
  per-session/per-vault instruction set inline. Complements output styles. **Depends on `M1`**
  (the durable store it writes into). (Claudian.)

## Memory

- **Durable memory store** (`M1`). A persisted, user-authored store of facts + instructions the
  agent carries across turns and sessions — the backing store `L6`'s `#…` capture writes into.
  Surfaced as a system-prompt overlay (same path output styles use), editable in settings. Add
  optional `remember`/`recall` tools so the agent can write/read its own durable notes through the
  approval gate. Per-vault scope first (`data.json` / vault adapter — mobile-safe, no node fs);
  per-session overlay and richer scoping later. Distinct from `A2` (per-*subagent-profile* memory).

## Project workspaces

A saved, scoped workspace ("NotebookLM inside the vault"): bundle a context scope + model +
system prompt + its own history under a name. (Obsidian Copilot "Projects".)

- **Project definition + scope + pinned model/prompt/history** (`P1`). A config
  `{ name, includeGlobs/tags, model?, systemPrompt?, sessionGroup }`, authored as a vault `.md`
  (frontmatter + body) for sync, loaded with the `loadVaultSkills`/`loadAgentProfiles` pattern.
  Entering a project pre-loads matching notes as default context (ignore matcher still applies),
  switches the active model + system-prompt overlay, and filters the session list to that group.

## Composer & permission UX

- **`+ Folder` → `/add-dir` working-dir scope** (`C1`). A granted folder becomes a working set:
  reads/writes **inside** auto-run, **outside** always ask. Pairs with `S2` (the security half).

## Integrations (MCP / ACP)

- **MCP client over Streamable HTTP** (`I1`). Latest transport (MCP spec 2025-03-26) + OAuth2.
  **Never stdio/subprocess** — networked always, `localhost` when the server is local, so mobile
  keeps working. Discovered MCP tools register alongside vault tools and flow through the same
  approval gate. Client only — never an MCP server.
- **MCP server config + auth in settings** (`I2`). Endpoint + OAuth, behind an egress warning
  like the web layer. Ships with `I1`.
- **ACP client (desktop)** (`I3`). Drive an *external* coding agent (Claude Code / Codex /
  Gemini CLI) from the chat pane over JSON-RPC — a second backend alongside the native pi loop.
  ACP is stdio/subprocess by design → **desktop-only**; mobile keeps the native loop.
- **Backend switch** (`I4`). Pick native-pi vs an external ACP agent per session; render the
  external agent's turn/tool stream in the existing transcript UI. Ships with `I3`.

## Security & infrastructure

- **Keystore for API keys** (`S1`). Use Electron `safeStorage` (OS-keychain-backed) on
  **desktop**; mobile has no plugin keychain, so it stays obfuscated `data.json` + the existing
  warning. Honest split: desktop = real secure storage, mobile = warned plaintext.
- **Working-dir read boundary** (`S2`). With `/add-dir` working dirs configured, reads/writes
  **outside** every granted dir route through the approval gate (ask); **inside** auto-run.
  Inverse of ignore-globs (allow-list working set vs deny-list); ignore-globs still win inside a
  granted dir. Empty config = today's behavior. Security half of `C1`.
- **External config file (YAML / frontmatter)** (`S3`). Let portable, git-friendly settings
  (providers, privacy, web backend, skill/agent folders) live in a vault `agentic-chat.config.yaml`
  / `.md` frontmatter, reusing the `loadVaultSkills` loader. `data.json` keeps UI state +
  **secrets only** — secrets never go in a synced vault file.
- **Per-turn file checkpoints + rewind modes** (`S4`). Snapshot the files a turn changed
  (write/edit/rename) so the existing conversation rewind can also restore **vault file state** —
  with a mode menu: "conversation only / files only / both." Needs our own lightweight per-turn
  snapshot of touched paths on the vault adapter (no host CLI does this for us). Completes the
  undo story beyond undo-last-change.

## Obsidian-native tools (differentiators)

Things only an *Obsidian* agent can do. (Graph/backlink, frontmatter-property, and link-aware
rename tools already shipped — see README.)

- **Heading / block-level `@`-mention** (`O1`). `@note#heading` / `@note^block` attaches a slice
  instead of the whole file — cheaper context, native to Obsidian's addressing. Extends the
  shipped mention/attachment system.
- **Conversation fork** (`O3`). Prompt editing already *rewinds*; forking keeps both branches as
  separate sessions. Cheap given the JSONL `parentId`/`leafId` linked-list already models branches.

## Subagents v2

Deferred from the shipped v1 (delegation, foreground, depth-1, cost-accounted).

- **Async/background subagent runs** (`A1`). Run registry + status polling + completion
  notification; sequential **chains** (scout→planner→worker output-passing). Also: git-worktree
  isolation, child↔parent blocking questions (`contact_supervisor`), acceptance/verification
  gates, persisting child transcripts as replayable side artifacts.
- **Per-agent memory for profiles** (`A2`). Our `AGENT.md` profiles declare a per-agent tool
  allowlist; add an optional per-profile memory scope so a persona accumulates durable notes.
  (obsidian-ai-agents.)

## Testing & developer experience

- **E2E test suite** (`D1`). Add end-to-end tests that run the plugin inside a real Obsidian instance. Use [`wdio-obsidian-service`](https://github.com/platers/wdio-obsidian-service) (purpose-built for Obsidian plugins): it auto-downloads Obsidian, sandboxes the instance, loads the plugin, and opens a test vault — no Docker required. WebdriverIO drives user interactions (open chat, send a message, verify vault file writes, approve tool calls). Runs in GitHub Actions CI alongside the existing `typecheck`/`test`/`build` jobs. The existing vitest suite mocks Obsidian entirely; E2E catches integration failures (view registration, tool gate wiring, settings persistence) that unit tests cannot. Reference: [`obsidian-timecodes-plugin`](https://github.com/gavvvr/obsidian-timecodes-plugin/) for a worked example with the wdio-electron-service variant (alternative if wdio-obsidian-service doesn't fit).
- **Formatting + extended lint** (`D2`). The lean base — an eslint flat config + `typescript-eslint`,
  a `lint` npm script, and a CI `lint` job alongside `typecheck`/`test`/`build` — lands first as a
  small batch item. This is the heavier follow-up: Prettier (or `@stylistic/eslint`) for consistent
  formatting plus stricter rules (`no-floating-promises`, import ordering/hygiene), run as a
  `format:check` + extended `lint` gate. Kept separate so the formatting churn is its own reviewable
  commit, not mixed into feature diffs.

## Polish & reach

- **Mermaid + callout render parity** (`X1`). Verify `AssistantBubble` renders mermaid diagrams
  and `> [!note]` callouts (Obsidian's `MarkdownRenderer` needs explicit post-processing for
  mermaid). (pi-plugin.)
- **Editor/file context-menu "Send selection to chat"** (`X2`). Right-click selected text or a
  note → add it as a scoped context chip, via `editor-menu`/`file-menu` events. (obsidian-chat.)
- **Custom (user-authored) output styles** (`X4`). Once the built-ins prove the model.
- **Document ingestion (PDF/EPUB/Office) as context** (`X5`). Parse non-image documents into
  attachable text; PDF text extraction is the reasonable first subset. (Obsidian Copilot.)
- **Internationalization (i18n)** (`X6`). Externalize UI strings; most Obsidian AI plugins are
  English-only. (Claudian ships 10 locales.)
- **Visual event debugger** (`X7`). A debug view over the `AgentEvent` stream (dev tool).

### Standing rules

- **Every item is evaluated for mobile UX** — no subprocess/stdio in-process, networked-only
  integrations, touch-friendly UI; arrow-key/keyboard features degrade gracefully on mobile.

---

## Bugs

Reported issues to be fixed, ordered by severity. **None currently open** — the last batch
(`/agent <unknown>` dead end and note drag-drop regression, both 2026-06-16) is fixed and
documented in the README. New bugs go here.

---

## Priority matrix

Value (1–10, to a general user) × effort (T-shirt). Sorted by value descending, then by
ascending effort. This is the build-order signal — the top rows are the high-leverage work.

| ID | Item | Value | Effort |
|----|------|:-----:|:------:|
| `R1` | Lexical-first Vault QA | 9 | M |
| `R3` | Semantic vault search (RAG) | 9 | XL |
| `R2` | Embeddings (local + OpenRouter) | 8 | XL |
| `L1` | Steering messages (mid-turn) | 8 | M |
| `L4` | Inline edit / Quick Ask | 7 | L |
| `R5` | Relevant-notes panel | 7 | L |
| `P1` | Project workspaces | 6 | L |
| `I1` | MCP client (Streamable HTTP) | 6 | L |
| `G1` | Generic OpenAI-compatible provider | 6 | M |
| `M1` | Durable memory store | 6 | M |
| `R4` | QA inline citations | 6 | S |
| `W2` | Better extraction (Readability) | 5 | M |
| `S1` | Keystore for API keys | 5 | M |
| `S4` | Per-turn file checkpoints + rewind | 5 | L |
| `L5` | Plan/todo tracker panel | 5 | M |
| `L2` | Message queue (type-ahead) | 5 | M |
| `L3` | `ask_user` clarification tool | 5 | S |
| `O1` | Heading/block-level `@`-mention | 5 | S |
| `G2` | Provider/preset settings UI | 5 | S |
| `X2` | Context-menu "Send selection to chat" | 5 | S |
| `X1` | Mermaid + callout render parity | 5 | S |
| `X5` | Document ingestion (PDF first) | 5 | L |
| `C1` | `+ Folder` → `/add-dir` working-dir scope | 4 | M |
| `S2` | Working-dir read boundary | 4 | M |
| `S3` | External config file (YAML) | 4 | M |
| `W1` | `fetch_url` read-more / pagination | 4 | S |
| `L6` | `#` inline persistent instruction | 4 | S |
| `W3` | Deep-research = subagent-backed | 4 | L |
| `I3` | ACP client (desktop) | 4 | XL |
| `X4` | Custom output styles | 4 | M |
| `D1` | E2E test suite (wdio-obsidian-service) | 4 | M |
| `X6` | Internationalization (i18n) | 4 | L |
| `G3` | TEE/confidential model filter | 3 | S |
| `D2` | Formatting + extended lint (prettier, import hygiene) | 3 | S |
| `A1` | Async/background subagent runs | 3 | XL |
| `A2` | Per-agent profile memory | 3 | M |
| `O3` | Conversation fork | 2 | S |
| `X7` | Visual event debugger | 2 | M |

> `I2` (MCP server config UI) ships with `I1`; `I4` (backend switch) ships with `I3` — folded
> into their parents above.
</content>
</invoke>
