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
- **Agent / subagent** (longer term) — a bundle: system prompt + model + allowed tools +
  default skills/style. This is where per-agent model routing lives.

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

- [ ] **Slash-command autocomplete menu.** Typing `/` opens a filterable command/skill
      menu in the composer.
- [ ] **`@`-mention context attach.** Mention notes/folders inline to add as context,
      beyond the current active-note attach button.
- [ ] **Inline action buttons on results.** Apply edit / retry / copy / run suggested
      skill — clickable affordances on result blocks.
- [ ] **Interactive in-pane lists.** `/skill` with no arg renders a clickable list (pick
      to run) instead of a static block.
- [ ] **Refactor `chat-view.ts`.** Already ~750 lines; split before adding this surface
      (composer, transcript, message bubble, slash/autocomplete as separate units).

## Milestone 3 — Modes + output styles

- [ ] **Mode dropdown (ask / plan / agent)**, visible in the composer.
  - **ask** — strictly read-only. The harness MUST block any mutating tool call and
    return a "read-only mode" note to the model (reuse the `beforeToolCall` gate so the
    denial reaches the model the normal way).
  - **plan** — for large info-gathering/synthesis or big vault restructures: produce a
    plan; no writes until approved.
  - **agent** — default. Tools behave per the configured approval policy (ask/allow/deny).
  - Implementation: presets over the existing approval system
    (`src/agent/approval.ts`) **plus** a per-mode system-prompt overlay.
- [ ] **Built-in output styles** (default / brainstorm / learning) as system-prompt
      overlays. Switchable via a `/config`-style command (which can configure more than
      just style) and/or a selector. Custom user styles deferred.

## Milestone 4 — Chutes provider (TEE privacy)

A second privacy-preserving option alongside OpenRouter ZDR routing and local Ollama.

- [ ] Add `chutes` as a third provider in `buildModel` (`src/llm/models.ts`), modeled on
      the Ollama branch: OpenAI-compatible endpoint + API key, with a TEE/confidential
      model flag exposed in privacy settings.
- [ ] Settings UI for the Chutes key/endpoint and model selection.
- [ ] (Stretch) Filter the model browser to TEE/confidential models, mirroring the ZDR
      filter, so privacy is enforced by construction.

## Milestone 5 — Agents / subagents (longer term)

The issue #2 §4 + §10 "workflow platform" leap. Depends on the taxonomy being settled.

- [ ] Define an **agent** unit: system prompt + model + allowed tools + default skills/style.
- [ ] **Per-agent model routing** (issue #2 §10): cheap/fast model for tool-heavy steps,
      capable model for reasoning.
- [ ] Agent selector in the mode dropdown / composer.

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
