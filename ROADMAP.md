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

## Toolset & context hygiene

The agent ships a wide tool surface (vault read/write/edit, find/grep, graph/backlinks,
frontmatter, web, memory). As it grows, two levers keep per-turn prompt cost and decision
noise down.

- **Tool consolidation / meta-tools** (`T1`). Merge overlapping vault tools, or wrap them in
  meta-tools the model fans out from (e.g. a single `search` umbrella over `grep`/`find`/
  backlinks), so fewer tool definitions ride the system prompt every turn. Design-sensitive —
  the approval-gate and ignore-list semantics must survive whatever new shape the tools take.
- **Context-budgeted tool dropping + notice** (`T2`). Tools are system-prompt weight that
  costs tokens every turn; once the context window fills past a low threshold (≈2%, tunable),
  auto-drop the least-relevant/unused tools from the registered set for the rest of the session
  and surface a notice so the user knows the agent's toolset shrank. Pairs with the shipped
  context gauge and the context-window guardrails.

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
  per-session/per-vault instruction set inline. Complements output styles. Writes into the durable
  memory store (`M1`, shipped). (Claudian.)

## Project workspaces

A saved, scoped workspace ("NotebookLM inside the vault"): bundle a context scope + model +
system prompt + its own history under a name. (Obsidian Copilot "Projects".)

- **Project definition + scope + pinned model/prompt/history** (`P1`). A config
  `{ name, includeGlobs/tags, model?, systemPrompt?, sessionGroup }`, authored as a vault `.md`
  (frontmatter + body) for sync, loaded with the `loadVaultSkills`/`loadAgentProfiles` pattern.
  Entering a project pre-loads matching notes as default context (ignore matcher still applies),
  switches the active model + system-prompt overlay, and filters the session list to that group.

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

- **E2E test suite — CI + coverage** (`D1`). The **base infra has landed** (local-only): a
  [`wdio-obsidian-service`](https://github.com/jesse-r-s-hines/wdio-obsidian-service) config
  (`wdio.conf.mts`), a throwaway test vault (`test/e2e/vault`), and a smoke spec
  (`test/e2e/specs/smoke.e2e.ts`) that boots a real Obsidian, loads the plugin, and checks view
  registration, the composer card, in-pane slash routing, the `/dirs` working-dir command, and
  active-note attachment — run with `npm run test:e2e`. See the README "End-to-end tests" section.
  **Open:** wire it into GitHub Actions CI (boots Electron, so it needs a headless display +
  Obsidian-download caching, kept separate from the fast `typecheck`/`lint`/`test`/`build` jobs),
  add the emulate-mobile/Android matrix, and grow coverage to the approval modal + a real
  model-backed turn (verifying a vault write) behind a gated API key.
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

Reported issues to be fixed, ordered by severity. New bugs go here; fixed ones move to the
README and out of this list. The last closed batch (`/agent <unknown>` dead end and note
drag-drop regression, 2026-06-16) is documented in the README.

- **Active note auto-attaches even when its path is ignore-listed** (e.g. `/Private/`).
  (2026-06-19) Opening a note always pins it as the active-note chip in the composer, but
  ignored/blacklisted paths attach too — pointless (the ignore matcher hides them from the
  model, so it can't read them) and leaky (the path shows in the UI). Attachments are already
  ignore-aware (path-only refs); the active-note auto-add should skip ignored paths entirely,
  the same as a manual attach.
- **Streaming pins the transcript to the bottom, blocking scroll-up.** (2026-06-19) While the
  agent streams, the chat pane auto-scrolls to the newest token on every update, so the user
  can't scroll up to read earlier output mid-stream. Fix: stick to bottom only when the user is
  already at/near the bottom; once they scroll up, pause auto-scroll until they return.

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
| `T1` | Tool consolidation / meta-tools | 6 | M |
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
| `T2` | Context-budgeted tool dropping + notice | 5 | S |
| `X5` | Document ingestion (PDF first) | 5 | L |
| `S3` | External config file (YAML) | 4 | M |
| `W1` | `fetch_url` read-more / pagination | 4 | S |
| `L6` | `#` inline persistent instruction | 4 | S |
| `W3` | Deep-research = subagent-backed | 4 | L |
| `I3` | ACP client (desktop) | 4 | XL |
| `X4` | Custom output styles | 4 | M |
| `D1` | E2E in CI + coverage (base infra shipped) | 4 | M |
| `X6` | Internationalization (i18n) | 4 | L |
| `G3` | TEE/confidential model filter | 3 | S |
| `D2` | Formatting + extended lint (prettier, import hygiene) | 3 | S |
| `A1` | Async/background subagent runs | 3 | XL |
| `A2` | Per-agent profile memory | 3 | M |
| `O3` | Conversation fork | 2 | S |
| `X7` | Visual event debugger | 2 | M |

> `I2` (MCP server config UI) ships with `I1`; `I4` (backend switch) ships with `I3` — folded
> into their parents above.

---

## Next batch

The previous batch (`NB1`–`NB6`) shipped — see **Shipped this batch** below. No
follow-ups are currently deferred from the latest review pass; new small items go
here as they surface.

### Shipped this batch

Already landed (documented in the README, not tracked as open work):

- **Context-window gauge (`NB1`)** — the composer-toolbar fill is restyled from a
  flat `<progress>` bar into an arc/gauge ring (CSS-only conic gradient keyed off a
  `--ctx-pct` var; the `contextLevel`/`contextPercent` helpers are unchanged).
- **Multi-file drag-to-attach + dedup image notice (`NB2`)** — a drop attaches
  every dragged entry at once (multi-select), and a batch of images a vision-less
  model can't read yields one aggregated toast instead of one per file.
- **Prompt-cache feedback (`NB3`)** — OpenRouter `cacheRead`/`cacheWrite` (already
  accumulated) surface as a prompt-cache hit ratio in the usage footer and `/usage`.
- **Claudian system-prompt study (`NB4`)** — research only. Claudian shells out to
  the `claude` CLI and inherits Claude Code's prompt; its portable lessons
  (conciseness, proactive tool use, guidelines over rigid rules) are already
  embodied in our `DEFAULT_SYSTEM_PROMPT`, so no text was ported (adding more would
  violate the brevity lesson). Folds into the future system-prompt work.
- **README: community-plugin install (`NB5`)** — "From Obsidian community plugins"
  is now the recommended install path, ahead of BRAT/manual.
- **E2E coverage of the new behavior (`NB6`)** — the local e2e suite grows past the
  smoke spec: the context gauge + dynamic effort knob (model-independent), plus a
  gated model-backed spec (`guardrails.e2e.ts`) for the approval modal + a real
  turn → vault write. Key-gated on `OPENROUTER_API_KEY`; local-only, not in CI.
- **Dynamic thinking levels** — the effort knob / `/effort` only offers levels the
  current model supports (`thinkingLevelMap`), and the requested level is clamped
  so we never send an unsupported `xhigh`.
- **Read de-dup + size guardrail** — a repeat read of the same range returns a
  pointer instead of re-injecting the file (edits invalidate it); a bulk read of a
  very large file is refused with pagination guidance.
- **Budgeted, ignore-aware attachments** — large attachments and ignore-listed
  (private) paths attach as path-only references, never full bodies, so a stack of
  attachments (or the active note in a blacklisted folder) can't blow — or leak —
  the context.
- **Self-aware system prompt** — the prompt states the plugin identity + active
  model id and bakes in the context-guardrail rules.
- **`trashFile` → `vault.trash`** — replaced a `1.6.6`-only API with the `0.9.7`
  equivalent so we stay within the declared `minAppVersion` (community-review fix).