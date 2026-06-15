# Roadmap

Direction for `agentic-chat`, the agent-led Obsidian sidebar chat. This is a living
document; milestones are ordered by dependency, not by calendar. It supersedes the
loose feature list in [issue #2](https://github.com/tardigrde/obsidian-agentic-chat/issues/2)
(most of which shipped in [PR #4](https://github.com/tardigrde/obsidian-agentic-chat/pull/4)).

## Guiding model

We follow Claude Code's conceptual split rather than collapsing everything into one
abstraction. **Skills**, **output styles**, and (later) **agents** are *distinct*
concepts that compose — they do not fully overlap:

- **Skill** — a reusable capability/instruction unit. Standardized on the
  [agentskills.io](https://agentskills.io) `SKILL.md` format. Loaded with progressive
  disclosure (name + description always visible to the model; full body loaded only on
  invocation). Prompt templates are absorbed here: a skill that takes `$ARGUMENTS` is
  just an invokable skill.
- **Output style** — *how* the assistant talks (tone, structure). A system-prompt
  overlay. Built-in set for now (default / brainstorm / learning).
- **Mode** — *what the agent is allowed to do* (ask / plan / agent). A preset over the
  approval + tool system, plus a system-prompt framing. Surfaced as a visible dropdown.
- **Agent / subagent** — a **profile** (system prompt + model + allowed tools + skills) the
  agent *delegates to*: the parent spawns a focused child session, runs it in isolation, and
  gets back a summary. **Delegation, not a whole-chat persona switch.** See Milestone 5.

### Out of scope

- **MCP** (issue #2 §3) — not pursuing.

---

## Milestone 1 — Taxonomy + slash cleanup (foundation)

Low-risk groundwork everything else builds on. No new providers, no new model behavior.

- [x] **Progressive-disclosure skills.** Already satisfied: pi's
      `formatSkillsForSystemPrompt` injects only `name`/`description`/`location` (no
      body), and the model reads the full `SKILL.md` on demand. Locked with a test.
- [x] **Merge templates into skills.** Skills now support `$ARGUMENTS`/`$1` via
      `buildSkillInvocation`; the `templatesFolder` is folded into the skill list and the
      setting is marked deprecated; `/template` is a deprecated alias to `/skill`. One
      loader (`loadVaultSkills`), one `/skill`.
- [x] **Reconcile execution semantics.** Already unified: both skills and (former)
      templates invoke through `agent.prompt()` as a user message; only the
      name/description list lives in the system prompt.
- [x] **Slash rendering rule: in-pane for everything.** Slash/skill/model/error output
      renders as in-pane blocks; the misused `Notice` calls in `chat-view.ts` are gone
      (only the startup-init notification remains, pending the notification layer).
- [x] **Toasts = notifications only.** Toasts now fire only for background signals
      (agent finished while you're elsewhere, context-window % thresholds, cost cap) via
      the notification layer below; foreground slash output is in-pane.

## Milestone 2 — Interactive pane (Copilot-inspired)

Make the pane carry actions, not just text. UX reference: GitHub Copilot chat sidebar.

- [x] **Slash-command autocomplete menu.** Typing `/` opens a filterable command/skill
      menu in the composer (`src/ui/autocomplete.ts` engine + `autocomplete-menu.ts`
      widget). `/skill <partial>` filters skills; the registry lives in `commands.ts`.
- [x] **`@`-mention context attach.** Typing `@` filters notes/folders inline; picking one
      adds it as a context chip (reusing the existing attachment system).
- [x] **Inline action buttons on results.** Copy and "ask again" (retry) on each assistant
      turn; "run suggested skill" is covered by the clickable `/skill` picker. Apply-edit
      stays with the **Edit diff review + undo** cross-cutting item.
- [x] **Interactive in-pane lists.** `/skill` with no arg renders a clickable picker (pick
      to run) instead of a static block.
- [x] **Refactor `chat-view.ts`.** Split into pure units (`format.ts`, `message-content.ts`,
      `commands.ts`, `autocomplete.ts`) plus DOM units (`assistant-bubble.ts`,
      `autocomplete-menu.ts`); `chat-view.ts` now just orchestrates.

## Milestone 3 — Modes + output styles

- [x] **Mode dropdown (ask / plan / agent)**, visible in the composer.
  - **ask** — strictly read-only. The harness MUST block any mutating tool call and
    return a "read-only mode" note to the model (reuse the `beforeToolCall` gate so the
    denial reaches the model the normal way).
  - **plan** — for large info-gathering/synthesis or big vault restructures: produce a
    plan; no writes until approved.
  - **agent** — default. Tools behave per the configured approval policy (ask/allow/deny).
  - Implementation: `src/agent/modes.ts` — presets over the existing approval system
    (`resolveModePolicy` wraps `resolvePolicy`; ask/plan deny mutating tools through the
    `beforeToolCall` gate) **plus** a per-mode system-prompt overlay. Surfaced as a
    composer dropdown and in `/config`/`/status`.
- [x] **Built-in output styles** (default / brainstorm / learning) as system-prompt
      overlays (`src/agent/output-styles.ts`, composed by `buildSystemPrompt`). Switchable
      via the `/config` command and a composer selector. Custom user styles deferred.
      See: https://code.claude.com/docs/en/output-styles

## Milestone 4 — Chutes provider (TEE privacy)

A second privacy-preserving option alongside OpenRouter ZDR routing and local Ollama.

- [ ] Add `chutes` as a third provider in `buildModel` (`src/llm/models.ts`), modeled on
      the Ollama branch: OpenAI-compatible endpoint + API key, with a TEE/confidential
      model flag exposed in privacy settings.
- [ ] Settings UI for the Chutes key/endpoint and model selection.
- [ ] (Stretch) Filter the model browser to TEE/confidential models, mirroring the ZDR
      filter, so privacy is enforced by construction.

## Milestone 5 — Subagents (delegation)

**Scope decision:** this milestone is **delegation only** — the parent agent spawns focused
**child** agents mid-task, each with its own context window, model, and tool subset, then
gets back a summary. It is **not** an "agent persona" you switch the whole chat into (that
preset idea is folded back into modes/output-styles, not pursued here). Motivation:
**parallelism** (fan out independent subtasks, merge) + **context isolation** (noisy
multi-step work happens in a child; only the result returns), *not* cost/model-routing.

**Design reference:** [`pi-subagents`](https://github.com/nicobailon/pi-subagents) solves
exactly this for the Pi CLI. We **port its design, not its code** — it is a Pi *host plugin*
(`bin`/`pi.extensions` loader, peer-deps on `@earendil-works/pi-coding-agent`, assumes Node
`fs` + `bash` + git worktrees), none of which this plugin has (vault-adapter JSONL sessions,
mobile-safe, no bash). `pi-agent-core`'s `Agent` is self-contained, so we nest it directly:
`new Agent({…})` → `prompt(task)` → `waitForIdle()` → read the final text from `state.messages`.
Also see Claude Code's model: https://code.claude.com/docs/en/sub-agents

### v1 deliverables (shipped)

- [x] **Agent profile unit + loader** (`src/agent/subagents.ts`). A profile is
      `{ name, description, systemPrompt, model?, toolAllowlist }`, authored as an `AGENT.md`
      (YAML frontmatter + body), loaded with the `loadVaultSkills` frontmatter pattern from a
      settings-configured folder. **Both** a built-in roster (researcher / reviewer / editor)
      **and** user vault files; a vault profile overrides a built-in of the same name. The body
      replaces the base prompt for the child.
- [x] **`subagent` dispatch tool** (`src/tools/subagent-tool.ts`). One tool, two foreground
      modes: single `{ agent, task }` and parallel `{ tasks: [{agent,task}], concurrency? }`.
      `execute(id, params, signal, onUpdate)` builds a child `Agent` per task — child `tools` =
      `createVaultTools` filtered to the profile allowlist; child `model` = `profile.model ??`
      parent; child `streamFn` reuses `buildStreamFn` (OpenRouter wiring + attribution); child
      `systemPrompt` from the profile. Fans out through a hand-rolled concurrency pool (default
      cap 3); `signal` → `child.abort()` so a parent abort kills all children. Returns merged
      child summaries as the tool result.
- [x] **Permission boundary: profile allowlist, auto-approved.** The **dispatch** is the
      approval boundary (`gateSubagentDispatch`): in a read-only mode children are forced
      read-only so a dispatch is free; in agent mode a dispatch that *can* mutate follows the
      `approval.mutating` policy (ask once / allow / deny). Inside a child, tools are
      pre-filtered to the allowlist, so its calls auto-run — no per-call modal storm under
      parallel fan-out.
- [x] **Depth guard.** Children are built from `createVaultTools` only and never receive the
      `subagent` tool, so the delegation depth is capped at one **by construction** (no
      grandchildren).
- [x] **Trigger: both.** Model-driven (profiles advertised in the system prompt as
      name+description, like skills; the model calls `subagent` to fan out) **and** user-driven
      (`/agent <name> <task>` slash command; no-arg `/agent` shows a picker that prefills the
      composer).
- [x] **UI: collapsed-per-child, expandable** (`AssistantBubble`). The dispatch renders as a
      step card listing each child (name + live status: running / done / failed), fed by the
      tool's `onUpdate` snapshots (`tool_execution_update`); click a row to expand that child's
      summary. Collapsed by default so the main thread stays clean but stays debuggable.
- [x] **Cost accounting.** Child `usage` (which lives outside the parent transcript) is summed
      into `getSessionUsage` via a per-session accumulator so fan-outs show their true token/$
      cost.

**Isolation consequence (accepted for v1):** child steps are **live-only**. The expandable
tree exists during the run; what persists to JSONL is the dispatch tool-result = the **summary
text**. Reopening an old session shows the summary, not replayable child steps. That is the
honest cost of context isolation; v2 may persist child transcripts as side artifacts.

### Deferred (v2+)

Async/background runs + run registry + status polling + completion notification; sequential
**chains** (scout→planner→worker output-passing); git worktree isolation; `pi-intercom`
`contact_supervisor` (child↔parent blocking questions); acceptance/verification gates;
`mcp:` tools (MCP is out of scope). Per-agent **cost routing** (cheap model for tool-heavy
steps) is enabled by `profile.model` but is not a v1 goal.

## Milestone 6 — Web search + deep research

Break the vault boundary: let the agent pull from the open web, then layer a
multi-step research modality on top.

- [ ] **Web search tool.** A typed tool the agent can call to query the web and read
      results, alongside the existing vault tools. Read-only, but **network-egress
      aware**: gate behind a setting (off by default) surfaced in privacy settings, since
      it sends query text off-device. Decide the backend (provider-native search vs.
      Brave/SearXNG endpoint) — favor an OpenAI-compatible/provider option to match the
      existing stack.
- [ ] **Fetch/read-page tool.** Companion to search: fetch a URL, return readable text
      (the agent picks which results to open). Same egress gating.
- [ ] **Deep research modality.** A multi-step plan→search→synthesize→cite loop that
      produces a sourced note. Implement as a **default skill** first (composes search +
      fetch + plan mode); promote to a dedicated **agent type** (M5) once the agent unit
      lands — own system prompt + tool allowlist + model routing.
- [ ] **Citations.** Research output writes inline source links/footnotes into the vault
      note so claims are traceable.

## Milestone 7 — Embeddings + RAG QA (far future)

Issue #2 §2. The most-requested feature across Obsidian AI plugins, but heaviest.

- [ ] Local and OpenRouter embeddings.
- [ ] Semantic vault search to back RAG-based Q&A (replace/augment the brute-force
      `search_vault`).

---

## Bugs

Reported issues to be fixed. Ordered by severity, not by fix order.

- [x] **Invisible error text.** Error blocks (`/skill <unknown>`) now use a neutral
      background with a red accent bar and normal-contrast body text (was red-on-red).
- [x] **Invisible text selection.** The user bubble now has an inverted `::selection`
      (and the error block its own), so highlights contrast with the accent/error fill.
- [x] **No prompt editing.** Clicking a sent user bubble reloads it into the composer;
      sending rewinds the conversation to that turn (in memory and on disk via
      `rewriteMessages`) and starts a fresh generation. Esc cancels.
- [x] **Model browser ignores ZDR setting.** `listOpenRouterModels` now passes both
      `zdr` and `data_collection=deny` so the browser only offers models the active
      privacy routing can actually reach.
- [x] **Red error rectangle in settings.** The plaintext-key banner is restyled as a
      caution notice (neutral panel, warning accent, readable text), not an error.
- [x] **`@` autocomplete breaks on spaces.** Mention tokens now allow spaces (multi-word
      paths like `200 Resources` match); the token ends at a line break, and a
      non-matching query simply hides the menu.
- [x] **File drag opens note instead of adding link.** Dropping a note on the composer
      attaches it as context (resolved to a vault-relative path) instead of opening it.
- [x] **No session rename.** Sessions can be renamed inline from the conversation list.
- [x] **No auto-naming.** Sessions are auto-titled from the first prompt after the first
      turn. (Deterministic for now — `deriveAutoName`; a small-model upgrade can replace
      the heuristic later, e.g. "hi" → "Greeting".)

## Cross-cutting

- [x] **Ignore lists (security).** User-configured gitignore-style globs
      (`settings.ignoredGlobs`) naming notes the model **cannot** read. Matcher in
      `src/vault/ignore.ts`; enforced at the tool layer (`src/tools/vault-tools.ts` —
      every tool consults it), never in the UI, so the model cannot route around it.
      Excluded paths report as "not found" — invisible, not just denied.
- [ ] **Context-window management.** pi sends the whole history each turn; long sessions
      hit the model limit and spike cost. Add auto-compaction/summarization of old turns
      as the context fills. The context-% **signal** now ships (`getContextFraction` +
      chrome readout + threshold notifications); auto-compaction itself is still open.
- [x] **Notification system.** `src/ui/notifications.ts` — a typed `Notifier` over
      Obsidian `Notice` with a master toggle (errors bypass it), wired in `ChatView` for
      agent-finished (when you're elsewhere), context-window thresholds (75/90%), and the
      cost cap. Threshold dedup via the pure `highestUnnotifiedThreshold` helper.
- [ ] **Token budget (issue #2 §8, partial).** A per-conversation **cost alert**
      (`notifications.costAlertUsd`) now warns once when crossed. Still open: pre-send
      cost *estimate* and a hard spend cap.
- [x] **API-key storage.** Settings now shows a plaintext-storage security warning
      (key lives in vault `data.json`, leaks on sync/share). OS-keychain storage remains
      a future enhancement.
- [ ] **Edit diff review + undo.** Show a diff in the approval flow and offer
      undo-last-change. Extends the `beforeToolCall` gate (`src/agent/approval.ts`) from
      yes/no into reviewable, reversible edits.
- [ ] **Rendering performance.** Make the interactive pane safe on desktop and mobile:
      append-only transcript rendering (avoid full `renderTranscript` rebuilds),
      throttled streaming with markdown parsed on finalize (not per token), cached
      vault file list for `@`-mentions. **No UI framework** — keep hand-rolled Obsidian
      DOM so the bundle stays lean. This is the real perf risk, not the interactivity.

## Backlog / ideas

- Visual event debugger over the `AgentEvent` stream (noted as an insight in issue #2).
- Custom (user-authored) output styles, once built-ins prove the model.
- Session export (JSONL → Markdown note); issue #2 wanted conversations exportable.
