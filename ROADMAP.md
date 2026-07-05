# Roadmap

Direction for `agentic-chat`, the agent-led Obsidian sidebar chat. This is a living
document. It tracks **only open work**; shipped features belong in the
[README](README.md). The 20-milestone local goal session in
[GOAL_20_SPEC.md](GOAL_20_SPEC.md) and the 10-milestone follow-up batch have
landed and are now historical context, not the active plan.

The competitive research checkpoint lives in
[COMPETITIVE_RESEARCH.md](COMPETITIVE_RESEARCH.md). Its conclusion still guides
the roadmap: Agentic Chat should compete on **trustworthy, mobile-safe,
Obsidian-native vault agency**: visible typed tools, citations, reversible edits,
auditability, local-first defaults, and no required desktop subprocess.

## Guiding model

We follow Claude Code's conceptual split rather than collapsing everything into one
abstraction. **Skills**, **output styles**, **modes**, and **subagents** are
distinct concepts that compose:

- **Skill** - a reusable capability/instruction unit ([agentskills.io](https://agentskills.io)
  `SKILL.md` format), loaded with progressive disclosure. *(Shipped.)*
- **Output style** - how the assistant talks, switched with `/style`. Built-in
  set: default / brainstorm / learning. *(Shipped.)*
- **Mode** - what the agent is allowed to do. A single **Safe <-> YOLO** toggle
  controls approval posture, while `/plan` is the sticky read-only command.
  *(Shipped.)*
- **Subagent** - a profile the agent delegates to: system prompt, model, and
  allowed tools, running in an isolated child session. *(v1 shipped; v2 below.)*

### Differentiation stance

Do not compete on broad AI chat breadth, provider checklists, or desktop
shell-agent breadth. Copilot already owns the broad "AI second brain" surface,
Claudian owns the desktop external-agent lane, and Smart Connections owns
zero-setup semantic note discovery. Our lane is the safer in-process agent that
can act on a vault while showing its work.

### Out of scope

- **stdio / subprocess transports on mobile.** Every in-process integration stays
  networked or in-process. MCP is **Streamable HTTP only**; ACP is desktop-only by
  nature.
- **MCP server role.** We are an MCP *client* only, never a server.

---

## Providers & privacy

OpenRouter, Ollama, generic OpenAI-compatible gateways, provider presets,
zero-data-retention filtering, Obsidian secret storage, and opt-in
OTLP/Langfuse observability export are shipped and documented in the README.
Open provider work is now about additional privacy affordances.

- **TEE/confidential model filter** (`G3`, stretch). Filter the model browser to
  TEE/confidential models, mirroring the ZDR filter, so privacy is enforced by
  construction.

## Vault QA & RAG

Lexical vault QA, exact citation contracts, retrieval diagnostics, relevant-notes
MVP, multilingual/indexing policy scaffolding, embedding providers, scoped
semantic bootstrap, and embedding-backed recall/reranking are shipped. Keep
tuning retrieval quality as part of related feature work rather than tracking a
separate open semantic milestone.

## Web & research

Readability-style web extraction, source artifacts across web/PDF/EPUB/Office
and transcript/video sources, artifact list/export, cross-format duplicate
detection, SHA-256 source text hashes, guarded ZIP-based document ingestion,
subagent-backed deep research, evidence ledger support, and citation plumbing
are shipped. Keep tuning research quality as part of source and integration
work.

## Toolset & context hygiene

The default model-facing vault surface has been consolidated around meta-tools
while preserving compatibility tools internally. Tool-schema-budgeted optional
tool dropping, user-visible diagnostics, request-abort guards, child subagent
per-call approval enforcement, and metadata-first trace export are shipped.

- **Grouped tool actions** (`T1`). Revisit the model-facing vault tool API so
  related operations are grouped behind clear discriminated `action` fields
  rather than many loosely related top-level tools. The goal is exact intent and
  safer approval UX: for example `vault_read` with `action: "read" | "search" |
  "list"` and explicit line-range/metadata options, plus `vault_mutate` with
  `action: "write_file" | "edit_file" | "rename_file" | "delete_file" |
  "delete_empty_dir"` rather than a generic file-shaped `delete` that the model
  tries on folders. Action names should drive validation, approval labels,
  diffs, checkpoints, and error messages. Keep recursive or destructive
  directory actions separate and explicit.
- **External workspace roots** (`W1`, desktop-only). Let users grant explicit
  filesystem roots outside the open Obsidian vault, such as a parent project
  folder, without pretending they are vault working directories. This needs a
  separate desktop-only file-tool surface with root-bound path validation,
  clear approval/diff behavior, its own ignore rules, and honest limits:
  Obsidian-native graph, backlinks, frontmatter APIs, sync semantics, and trash
  are vault-only unless a file also lives inside the vault. W1 does not include
  a bash or command-runner tool. External-root tools should only be registered
  when the user has enabled the feature in settings and configured at least one
  root directory. The initial product shape should optimize for a single
  external root directory; multiple roots may be supported later, but W1 should
  not introduce repository mapping or per-repo abstractions. The motivating
  workflow is learning and maintaining a large codebase workspace whose
  knowledge vault describes the codebase without containing it.
  The first version is inspect-only: list, read, and search external files.
  Do not add external write/edit/delete tools yet, but keep the design open to
  a future explicit mutation tier. Model-facing paths and generated vault notes
  should cite external files with an `external://` prefix plus a root-relative
  path, not raw absolute filesystem paths. Treat those references as passive
  citations rather than Obsidian links; a separate command may open an
  `external://` reference in the system default app. Keep v1 live-on-demand:
  no persistent external-root index, no watcher, and no background scan. Add a
  separate external ignore list for files and folders under the external root;
  do not reuse the vault ignore list for this boundary. External tools should
  also honor `.gitignore` rules, including nested `.gitignore` files, by default.
  Resolve real paths for external tool targets and never follow symlinks outside
  the configured external root. Hidden files and dot-directories are eligible
  for list/read/search when not ignored, but text/binary and size guards still
  apply. Ignore obvious local secrets by default, including `.env`, `.env.*`,
  `*.pem`, `*.key`, and `.ssh/`. Expose v1 as one compact read-only
  `external_inspect` meta-tool with `list`, `read`, and `search` actions rather
  than separate per-action tools. Keep v1 configuration global to the plugin:
  an enable switch, one absolute external root path, an external ignore list,
  and an "honor .gitignore" toggle defaulted on. Project-scoped external roots
  can be considered later if one vault needs to cover multiple unrelated
  codebases. The feature is disabled by default. When enabled,
  `external_inspect` defaults to ask-before-run, with standing allow/deny
  options only after deliberate user configuration. Search returns matching paths plus short
  snippets and line numbers, not whole files; the agent should call
  `external_inspect` with `read` and an explicit slice for selected files.
- **Desktop utility runner** (`W2`, exploratory, desktop-only). Consider an
  optional, carefully permissioned local utility tool for desktop users working
  with large external workspaces. This is not part of W1 and must not turn the
  plugin into a broad shell-agent competitor. The useful product shape is a
  constrained allowlisted runner for discovery/filtering commands such as `rg`,
  `find`, `sed`, `wc`, and `jq`, with root-bound working directories, explicit
  approvals, command/output auditing, tight output caps, timeout controls,
  secret/path redaction, and clear deny-by-default settings. It is unavailable
  on mobile and should degrade to `external_inspect` plus vault tools. The goal
  is token-efficient inspection and summarization of local codebases, not
  arbitrary automation or mutation.

## Live interaction & in-editor editing

Steering messages, editable type-ahead queueing while a turn is running, `#`
inline persistent instruction capture, inline edit / Quick Ask, and the
plan/todo tracker are shipped.

## Integrations (MCP / ACP)

MCP Streamable HTTP tools, generic settings UX, OAuth desktop and mobile
sign-in, secret storage, runtime diagnostics, large-result artifacts, bounded
SSE resume, async `202` completion, and protocol fallback are shipped. Remaining
work is about long-lived event surfaces, non-tool capabilities, and the optional
desktop companion lane.
- **Generic MCP setup live coverage** (`I8`). The setup UI is shipped. Add broader
  live e2e coverage against representative public OAuth and static-header
  Streamable HTTP servers, without bundling presets or weakening the conservative
  default approval posture.
- **MCP Streamable HTTP event consumers** (`I6`). The request/response client is
  hardened. Only build long-lived background server-initiated event consumers
  when a concrete feature needs them.
- **MCP non-tool capabilities** (`I7`, low priority). Decide if and how to expose
  MCP resources, prompts, roots, sampling, elicitation, and richer binary/resource
  result rendering without turning the plugin into an MCP server or leaking vault
  contents by default.
- **ACP client (desktop companion)** (`I3`). Drive an external coding agent
  (Claude Code / Codex / Gemini CLI) from the chat pane over JSON-RPC. ACP is
  stdio/subprocess by design, so this remains desktop-only and low priority.
  `I4` backend switching is folded into this item.

## Security & configuration

- **External config file (YAML / frontmatter)** (`S3`). Let portable,
  git-friendly settings (providers, privacy, web backend, skill/agent folders)
  live in a vault `agentic-chat.config.yaml` or `.md` frontmatter file, reusing
  the vault loader patterns. `data.json` keeps UI state and secret references
  only; secrets never go in synced vault files.

## Obsidian-native tools

Graph/backlink tools, frontmatter-property tools, link-aware rename, evidence
ledger, action audit log, checkpoints, and rewind support are shipped.

- **Conversation fork** (`O3`). Prompt editing already rewinds; forking keeps both
  branches as separate sessions. The JSONL `parentId`/`leafId` structure already
  models branches, so this should be a focused session-management feature.

## Subagents v2

Deferred from the shipped v1: delegation, foreground execution, depth-1 only, and
cost-accounted summaries are already available.

- **Async/background subagent runs** (`A1`). Add run registry, status polling,
  completion notification, sequential chains, child-to-parent blocking questions,
  acceptance/verification gates, and replayable child transcript artifacts. Keep
  this focused on governed vault research/review chains first.
- **Per-agent memory for profiles** (`A2`). Add optional per-profile memory scope
  so a persona accumulates durable notes, building on Memory v2.

## Memory v2

Memory extraction, reviewable creation, on-demand retrieval, consolidation,
forgetting, provenance, management, export, and explicit clear are shipped. The
remaining question is scope.

- **Scope** (`V4`). Decide whether memory stays per-vault only, adds a cross-vault
  user layer, or supports both. The decision must account for sync, privacy,
  project workspaces, and per-agent memory.

## Polish & reach

- **Custom (user-authored) output styles** (`X4`). Allow synced, user-authored
  styles once the built-in style model is stable enough.
- **Internationalization (i18n)** (`X6`). Externalize UI strings. Most Obsidian
  AI plugins are English-only; this can become a reach differentiator when the UI
  surface stops moving quickly.
- **Visual event debugger** (`X7`). A developer-facing view over the `AgentEvent`
  stream for debugging runtime ordering, tool calls, approvals, and replay.

### Standing rules

- **Every item is evaluated for mobile UX**: no subprocess/stdio in-process,
  networked-only integrations, touch-friendly UI, and keyboard-only affordances
  must degrade gracefully.

---

## Bugs / Known Blockers

- `skipLibCheck` remains enabled because `tsc --noEmit --skipLibCheck false`
  currently fails in upstream `@anthropic-ai/sdk` declarations that reference
  unresolved relative `undici-types` fallback paths. Recheck this when
  `@earendil-works/pi-ai` moves to a fixed Anthropic SDK; `@anthropic-ai/sdk`
  `0.106.0` still uses the same fallback import pattern as of 2026-06-27. Our
  source, unit tests, e2e TypeScript, and e2e lint are covered by local gates.

---

## Priority matrix

Value (1-10, to a general user) x effort (T-shirt). This is the build-order
signal, but dependencies can override raw value/effort sorting.

| ID | Item | Value | Effort |
|----|------|:-----:|:------:|
| `I6` | MCP Streamable HTTP event consumers | 5 | M |
| `S3` | External config file (YAML/frontmatter) | 4 | M |
| `X4` | Custom output styles | 4 | M |
| `X6` | Internationalization (i18n) | 4 | L |
| `T1` | Grouped tool actions | 4 | M |
| `G3` | TEE/confidential model filter | 3 | S |
| `V4` | Memory scope: per-vault vs cross-vault | 3 | S |
| `W1` | External workspace roots | 3 | L |
| `W2` | Desktop utility runner | 3 | XL |
| `I8` | Generic MCP setup live coverage | 3 | M |
| `A2` | Per-agent profile memory | 3 | M |
| `I7` | MCP non-tool capabilities | 3 | L |
| `A1` | Async/background subagent runs | 3 | XL |
| `O3` | Conversation fork | 2 | S |
| `X7` | Visual event debugger | 2 | M |
| `I3` | ACP client (desktop companion) | 2 | XL |

---

## Next batch

The previous 20-milestone goal session and the 10-milestone follow-up are
complete. Semantic retrieval, context-budgeted tool dropping, type-ahead
queueing, `#` instruction capture, EPUB/Office ingestion, source-artifact
export/dedupe coverage, document-ingest guardrails, subagent child-call approval
enforcement, local data lifecycle commands, subagent-backed deep research, and
mobile MCP OAuth have now landed. The next high-leverage batch should pick off
integration depth and portable customization:

| # | IDs | Milestone | Checkpoint gate |
|---|---|---|---|
| 1 | `I6` | Streamable HTTP event consumers only where a concrete feature needs long-lived server events. | Protocol fallback tests plus bounded background-event lifecycle coverage. |
| 2 | `S3` | Portable vault config in YAML/frontmatter while keeping UI state and secret references in data.json. | Config loader tests plus secret redaction regression coverage. |
| 3 | `X4` | Custom synced output styles once the built-in style model has stabilized. | Style loading/switching tests plus prompt-overlay regression coverage. |
| 4 | `X6` | Internationalization once the UI surface stops moving quickly. | String extraction tests plus representative settings/chat rendering coverage. |
| 5 | `G3` | TEE/confidential model filter beside the shipped ZDR filter. | Model browser filter tests plus privacy copy regression coverage. |

After that, choose from `V4`, `I8`, `A2`, `O3`, or `X7` based on which workflow
is being dogfooded most.
