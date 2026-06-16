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
- **Mode** — *what the agent is allowed to do*. Collapsed to a single visible **Safe ↔ YOLO**
  slider (Safe = honor the settings approval policy; YOLO = session auto-approve all mutating).
  **Plan** (read-only, plan-only) is no longer a visible mode — it's the `/plan` command (sticky
  read-only until `/endplan`), which doubles as the fully-read-only lock. See M3 revision / M10.
- **Agent / subagent** — a **profile** (system prompt + model + allowed tools + skills) the
  agent *delegates to*: the parent spawns a focused child session, runs it in isolation, and
  gets back a summary. **Delegation, not a whole-chat persona switch.** See Milestone 5.

### Out of scope

- **stdio / subprocess transports on mobile.** Every integration stays networked or in-process
  so mobile keeps working: MCP is **Streamable HTTP only** (M11), and the ACP client is
  **desktop-only** by nature (M12). No shell/subprocess in the in-process agent.
- **MCP server role.** We are an MCP *client* only (M11), never a server.

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

### Revision — collapse to Safe/YOLO (planned, see M10)

- [ ] The shipped ask/plan/agent **dropdown is superseded** by the M10 single **Safe ↔ YOLO**
      slider + the `/plan` command. `resolveModePolicy` stays the engine; the visible mode
      dropdown and the redundant ask-mode/plan-mode split go away. Safe = honor settings
      approval policy; YOLO = session master auto-approve. Precedence: `/plan` > slider >
      per-tool override > settings default.
- [ ] **Output style via `/style` only.** Remove the composer style selector; `/style` switches
      default / brainstorm / learning. New sessions default to **normal** (default) style.

## Milestone 4 — Privacy-preserving providers (generalized)

Generalize to a **generic OpenAI-compatible provider** so any privacy option is *config, not
code*, alongside OpenRouter ZDR routing and local Ollama. The Ollama branch already proves the
shape.

- [ ] **Generic OpenAI-compatible provider** in `buildModel` (`src/llm/models.ts`): endpoint +
      API key + privacy flags, modeled on the Ollama branch. Named presets — **Chutes** (TEE/
      confidential), **Venice.ai**, **LM Studio**, **vLLM**, llama.cpp — become settings entries,
      not new code branches.
- [ ] **Settings UI** for endpoint/key/model selection per provider/preset.
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

- [x] **Web search tool.** `web_search` (`src/tools/web-search.ts`) queries a configured
      backend and returns ranked title/URL/snippet results. Read-only but **network-egress
      aware**: the whole web layer is gated behind a single off-by-default setting
      (`settings.web.enabled`) surfaced under "Web access" with an egress warning — when off
      the tools are not registered, so the model can't reach the network. Backend is a small
      provider abstraction (Tavily / Brave / SearXNG), keyed/configured in settings; the
      HTTP layer is injected (`WebFetcher`) and production wraps Obsidian `requestUrl`
      (mobile-safe, no CORS).
- [x] **Fetch/read-page tool.** `fetch_url` (`src/tools/web-fetch.ts`): fetches an http(s)
      URL and returns readable text (`extractReadableText` strips scripts/markup, decodes
      entities, no DOM needed). Same egress gate; best-effort SSRF guard
      (`normalizeWebUrl` blocks non-http(s) and localhost/private/link-local hosts) since a
      fetched page can steer the model.
- [x] **Deep research modality.** Shipped as a **default skill** (`deep-research` in
      `src/skills/builtin-skills.ts`), advertised only when web access is on: a
      plan→search→read→synthesize→cite→save loop that composes `web_search` + `fetch_url` +
      the write tool. Promotion to a dedicated **agent type** (M5) is still deferred.
- [x] **Citations.** The deep-research skill requires inline source links plus a
      `## Sources` list, and both web tools surface result/source URLs so claims are
      traceable.
- [ ] **Read-more / pagination for `fetch_url`.** Add an `offset` param so the model can fetch
      the next window of a truncated page (subsumes a one-shot "double the limit") and learn
      whether more remains. The char limit applies to the *already-extracted tidy text*, not raw
      HTML (raw is pre-capped at `MAX_RAW_CHARS`).
- [ ] **Better extraction (Readability).** The hand-rolled regex stripper (`extractReadableText`)
      returns *all* visible text — nav, footer, cookie banners, ads — with no main-content
      detection, so it wastes the char budget on boilerplate. Upgrade to Mozilla Readability via
      the platform `DOMParser` (present in the Obsidian renderer on **desktop and mobile**),
      keeping the regex path as fallback.
- [ ] **Deep-research = subagent-backed orchestration.** Re-back the `deep-research` skill with
      the M5 `subagent` dispatch: a supervisor fans out parallel searcher children (isolated
      context) + adversarial verify, then synthesizes — matching the open_deep_research /
      langchain deepagents / Gemini topology, instead of one flat prompt loop. Keep
      `/deep-research` as the entry point. **Model configurable** via the research **profile's
      `model`** field (M5). Refs: open_deep_research, langchain deepagents, @forecastx/deep-research.

## Milestone 7 — Embeddings + RAG QA (far future)

Issue #2 §2. The most-requested feature across Obsidian AI plugins, but heaviest.

- [ ] Local and OpenRouter embeddings.
- [ ] Semantic vault search to back RAG-based Q&A (replace/augment the brute-force
      `search_vault`).
- [ ] **Lexical-first Vault QA, embeddings as an upgrade.** Ship a "chat with the whole
      vault" retrieval mode that works **day one** on lexical/grep ranking (no index
      required), then swap in embeddings for relevance without changing the UX. Avoids
      gating QA on the heaviest part of the milestone. (Pattern from Obsidian Copilot's
      "Smart Vault Search.")
- [ ] **Inline citations.** Prompt the QA/research path to cite the exact
      `[[note#heading]]`/`^block` it drew each claim from, rendered as clickable links, so
      answers are verifiable. (Generalizes the M6 §4 citation item to vault QA.)
- [ ] **Relevant-notes panel (ambient discovery).** A sidebar section that surfaces notes
      related to what you're reading/writing — no prompt — ranked by embeddings + backlink
      proximity (rides the graph/backlink tools idea). A *non-chat* delivery surface; the
      flagship PKM differentiator once embeddings + graph land.

## Milestone 8 — Live interaction + in-editor editing

From a competitive review (Claudian, obsidian-chat, pi-plugin, Obsidian Copilot). Make the
running agent steerable and let edits happen where the cursor is, not only in the chat pane.
Everything here stays in-process and mobile-safe — no shell/subprocess.

- [ ] **Steering messages.** Inject a message into a *running* turn to course-correct
      without aborting (today we only have abort). pi-agent-core should support queued user
      input mid-loop; surface a send-while-running affordance that feeds the in-flight
      agent. Cheapest high-impact win since we already own the pi loop. (pi-plugin.)
- [ ] **Message queue (type-ahead while running).** Messages typed during a turn stay
      editable until the turn ends, then send. **Design tension with steering — needs
      refinement:** a mid-run message could either *steer now* or *queue for next*. Decide a
      default and an explicit modifier (e.g. plain Enter = queue, Shift/Cmd = steer now), or
      one unified composer that routes by intent. Resolve before building either. (Claudian.)
- [ ] **`ask_user` clarification tool.** A typed tool the agent calls to pause and ask the
      user a structured question mid-task (distinct from emitting prose). Renders as an
      inline prompt; pairs with the approval gate and plan/agent modes. (obsidian-chat.)
- [ ] **Inline edit / Quick Ask.** Select text in a note (or at the cursor) + a hotkey →
      the agent rewrites **in place**, shown as a word-level diff to accept/reject, no chat
      round-trip. Strong Obsidian-native surface and a clear gap; composes with the
      Cross-cutting "Edit diff review + undo" item (shared diff/accept UI).
      (Claudian `InlineEditModal`; Copilot "Quick Command".)
- [ ] **Plan/todo tracker panel.** Render the agent's plan (its `todo`-style steps) as a
      live `Tasks (x/y)` checklist surfaced above the transcript, not buried in tool steps.
      (Claudian `StatusPanel` — todo half only; its bash-console half needs a shell we don't
      have.)
- [ ] **`#` inline persistent instruction.** Typing `#…` in the composer appends a durable
      custom instruction (lightweight "remember this") rather than sending a prompt — grows
      a per-session/per-vault instruction set inline. Complements output styles. (Claudian.)

## Milestone 9 — Project workspaces

A saved, scoped workspace ("NotebookLM inside the vault"): bundle a context scope + model +
system prompt + its own history under a name. Composes with what already ships (sessions,
ignore-globs, model picker, output styles). (Obsidian Copilot "Projects".)

- [ ] **Project definition.** A config `{ name, includeGlobs/tags, model?, systemPrompt?,
      sessionGroup }`, authored as a vault `.md` (frontmatter + body) for sync/portability,
      loaded with the `loadVaultSkills`/`loadAgentProfiles` frontmatter pattern.
- [ ] **Scoped context pre-load.** On entering a project, matching notes (folder/tag globs)
      are available as default context; the ignore matcher still applies.
- [ ] **Pinned model + prompt + isolated history.** Selecting a project switches the active
      model and system-prompt overlay and filters the session list to that project's group.

---

## Milestone 10 — Input-area & permission UX (composer redesign)

A cohesive cluster from the Claudian input-area review (`image.png`). Everything mobile-safe.

- [ ] **Single permission slider (Safe ↔ YOLO).** Replace the ask/plan/agent mode dropdown +
      the separate approval toggle with one visible slider over the existing `beforeToolCall`
      gate. **Safe** honors the settings approval policy (per-tool overrides + `approval.mutating`);
      **YOLO** is a session master switch forcing auto-approve on all mutating tools. Two layers:
      settings = granular default, slider = session master. (See M3 revision.)
- [ ] **`/plan` command (sticky read-only).** Plan leaves the visible chrome; `/plan` enters a
      sticky read-only + plan-framing state until `/endplan`, and doubles as the fully-read-only
      lock. Precedence: `/plan` > slider > per-tool > settings default.
- [ ] **Model pill in the composer (short label).** Move the model switcher into the composer
      footer. OpenRouter slugs are long — show a short label (catalog `name`, fallback last path
      segment), ellipsis at a fixed width, full slug in `title` + the existing `SuggestModal`
      picker (unchanged).
- [ ] **Active note attached by default.** Drop the `+ Active note` button; auto-attach the
      active leaf as a **removable** context chip each turn. Truncation ladder: full note →
      visible editor range → path only. Mobile: active leaf resolves the same.
- [ ] **`+ Folder` → `/add-dir` working-dir scope.** A granted folder becomes a working set:
      reads/writes **inside** auto-run, **outside** always ask. The security half lives in
      Cross-cutting "Working-dir read boundary."
- [ ] **Effort knob stays in the composer.** Quick per-turn knob; kept visible (unlike output
      style, which moves to `/style`).
- [ ] **Multiple tabs in one pane (deferred).** Up to N independent sessions in the same leaf,
      tab-switched. Session infra exists; UI plumbing is the cost. Roadmap-only for now.

## Milestone 11 — MCP client (networked only)

Reverses the earlier "MCP out of scope." **Client only — this plugin is never an MCP server.**

- [ ] **MCP client over Streamable HTTP.** Latest transport (MCP spec 2025-03-26, replaced
      HTTP+SSE) + OAuth2. **Never stdio/subprocess** — networked always, `localhost` when the
      server is local, so mobile keeps working. Discovered MCP tools register alongside vault
      tools and flow through the same approval gate.
- [ ] **Server config + auth in settings** (endpoint + OAuth), behind an egress warning like
      the web layer.

## Milestone 12 — ACP client (desktop)

This plugin as an **Agent Client Protocol client**: drive an *external* coding agent (Claude
Code / Codex / Gemini CLI) from the chat pane — a second backend alongside the native pi loop
(openclaw-style bridge).

- [ ] **ACP client transport.** Spawn + drive an ACP agent over JSON-RPC. ACP is
      **stdio/subprocess by design → desktop-only**; mobile keeps the native pi loop. Identity
      shift accepted: the plugin becomes "own agent **+** universal client" (Zed-style dual
      backend).
- [ ] **Backend switch.** Pick native-pi vs an external ACP agent per session; render the
      external agent's turn/tool stream in the existing transcript UI.

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

### Bug sweep (2026-06-15)

Triaged from an automated 42-item report; most were false or trivial. Fixed the real ones:

- [x] **`newSession()` swap race.** Rapid double-trigger of "New conversation" could
      interleave `detachAgent`/`createSession`/`replaceAgent`. Session swaps now serialize
      through `enqueueSessionSwap` in `AgentService` (`newSession` + `loadSession`).
- [x] **`ChatView.newSession()` left stale view state on error.** Attachment/transcript
      reset moved into `finally` so a failed swap clears the pane instead of showing stale
      chips and an old transcript.
- [x] **Model browser crash on null model name.** `ModelSuggestModal.getSuggestions`
      guards `model.name?.toLowerCase()` so an OpenRouter entry with a null `name` no
      longer throws.
- [x] **`tsconfig` skipped `vitest.live.config.ts`.** Added to `include` so type errors in
      the live-test config are caught by `tsc -noEmit`.
- [x] **Approval-modal copy typo** ("for now on" → "from now on").

Dismissed as false/non-bugs: duplicate release tags (semantic-release tags once via
`tagFormat`; `@semantic-release/npm` with `npmPublish:false` does not git-tag — verified
single tags in history), `styles.css` CI validation (committed source, not a build
artifact), parallelizing the `grep` tool (the serial loop's early-break at `maxMatches` is
deliberate — fanning out reads the whole vault), and the session `modifiedTime` `continue`
(uses `message.timestamp` by design).

### Reported (2026-06-16)

- [ ] **`/agent <unknown>` is a dead end.** `invokeAgent` (`agent-service.ts:307`) reports
      `No subagent named "x"` with no list. Append the available profile names; and if the name
      matches a **skill** (e.g. `deep` → `deep-research`), hint the `/skill` / `/<skill>` form.
- [ ] **Note drag-drop does nothing now.** The earlier "attach as chip" fix regressed —
      file-explorer drags no longer carry `obsidian://` in `dataTransfer`, so
      `parseDroppedVaultPath` no-ops. **Decision: option B** — read the dragged `TFile` from
      `app.dragManager`, keep the chip behavior, and make **folder drops also attach as a chip**
      (consistency), not insert path text.

## Cross-cutting

- [x] **Ignore lists (security).** User-configured gitignore-style globs
      (`settings.ignoredGlobs`) naming notes the model **cannot** read. Matcher in
      `src/vault/ignore.ts`; enforced at the tool layer (`src/tools/vault-tools.ts` —
      every tool consults it), never in the UI, so the model cannot route around it.
      Excluded paths report as "not found" — invisible, not just denied.
- [x] **Context-window management.** pi sends the whole history each turn; long sessions
      hit the model limit and spike cost. Auto-compaction now ships: `src/agent/compaction.ts`
      (pure cut-point + token-estimate logic) plus `AgentService.maybeCompact`, which
      summarizes old turns into a single summary message before a send once the window fills
      past a configurable threshold (`settings.compaction`). Dropped-turn usage is folded into
      the session total so cost never shrinks; the summary renders as a distinct, non-editable
      transcript block and toasts once via the notification layer. Summarization uses pi's
      `generateSummary` (injectable for tests). The context-% signal (`getContextFraction` +
      chrome readout + threshold notifications) was the precursor.
- [x] **Notification system.** `src/ui/notifications.ts` — a typed `Notifier` over
      Obsidian `Notice` with a master toggle (errors bypass it), wired in `ChatView` for
      agent-finished (when you're elsewhere), context-window thresholds (75/90%), and the
      cost cap. Threshold dedup via the pure `highestUnnotifiedThreshold` helper.
- [x] **Token budget (issue #2 §8).** Complete: a per-conversation **cost alert**
      (`notifications.costAlertUsd`) warns once when crossed; a **pre-send cost estimate**
      (`AgentService.estimateNextCost` via `src/agent/cost.ts`, shown as "next ~$x" in the
      chrome for priced models); and a **hard spend cap** (`notifications.costCapUsd`) that
      blocks new turns pre-send and aborts a running turn once the conversation cost reaches
      the cap.
- [x] **API-key storage.** Settings now shows a plaintext-storage security warning
      (key lives in vault `data.json`, leaks on sync/share). OS-keychain storage remains
      a future enhancement.
- [ ] **Keystore for API keys.** Use Electron `safeStorage` (OS-keychain-backed encryption) on
      **desktop**; mobile has no plugin keychain access, so it stays obfuscated `data.json` + the
      existing warning. Honest split: desktop = real secure storage, mobile = warned plaintext.
      Pairs with the external-config item — **secrets never go in a synced vault file**.
- [ ] **Working-dir read boundary (security).** Today all reads auto-run (read-only = free). With
      `/add-dir` working dirs configured, reads/writes **outside** every granted dir route through
      the approval gate (ask); **inside** auto-run. Inverse of ignore-globs (allow-list working
      set vs deny-list); ignore-globs still win inside a granted dir. Empty config = today's
      behavior. The security half of the M10 `+ Folder` item.
- [ ] **External config file (YAML / frontmatter).** Let the portable, git-friendly, syncable
      settings (providers, privacy, web backend, skill/agent folders) live in a vault
      `agentic-chat.config.yaml` / `.md` frontmatter, reusing the
      `loadVaultSkills`/`loadAgentProfiles` loader pattern. `data.json` keeps UI state +
      **secrets only** (secrets never in a synced file).
- [ ] **Edit diff review + undo.** Show a diff in the approval flow and offer
      undo-last-change. Extends the `beforeToolCall` gate (`src/agent/approval.ts`) from
      yes/no into reviewable, reversible edits. Shares its diff/accept UI with the M8
      **Inline edit / Quick Ask** surface.
- [ ] **Per-turn file checkpoints + rewind modes.** Snapshot the files a turn changed
      (write/edit/rename), so the existing conversation rewind (`truncateMessages`) can also
      restore **vault file state** — with a mode menu: "conversation only / files only /
      both." We have no host CLI doing this for us (unlike Claudian, which rides Claude
      Code's `fileCheckpointing`), so it needs our own lightweight per-turn snapshot of
      touched paths on the vault adapter. The full undo half of "Edit diff review + undo."
- [x] **Rendering performance.** The interactive pane is hand-rolled DOM (no framework).
      Markdown is parsed once on finalize, not per token (`AssistantBubble.finalizeText`);
      streamed deltas are buffered and flushed once per animation frame
      (`scheduleFlush`/`flushBuffers`) so a fast token stream is one reflow/frame, not one
      per token; the live path is append-only (events append to bubbles — `renderTranscript`
      only rebuilds on session load/new/edit, which are genuinely different transcripts); the
      `@`-mention candidate list is cached and invalidated on vault create/delete/rename
      (`mentionCache`). Scroll is `requestAnimationFrame`-coalesced.

## Backlog / ideas

- Visual event debugger over the `AgentEvent` stream (noted as an insight in issue #2).
- Custom (user-authored) output styles, once built-ins prove the model.
- Session export (JSONL → Markdown note); issue #2 wanted conversations exportable.
- **Docs: BRAT install first.** List the BRAT (pre-release) install method *ahead of* manual
  install in the README — it's the primary distribution path.
- **Repo: AGENTS.md is the real file, CLAUDE.md a symlink** to it (AGENTS.md is the emerging
  cross-tool standard). Windows-checkout symlink fragility accepted (don't care).
- **Standing rule: every item is evaluated for mobile UX** — no subprocess/stdio in-process,
  networked-only integrations, touch-friendly UI, arrow-key/keyboard features degrade gracefully.

### Obsidian-native tools (differentiators)

These are things only an *Obsidian* agent can do — higher-signal than re-deriving
generic chat features.

- **Graph / backlink tools.** `get_backlinks`, `follow_links`, `local_graph(note)` as
  typed tools so the agent traverses the `[[wikilink]]` graph instead of brute-grep.
  Read-only; consults the ignore matcher like every other vault tool. Strongest single add.
- **Heading / block-level `@`-mention.** `@note#heading` / `@note^block` attaches a slice
  instead of the whole file — cheaper context, native to Obsidian's addressing. Extends the
  existing mention/attachment system in `chat-view.ts` + `autocomplete.ts`.
- **Vision attachments.** Attach vault images to a multimodal OpenRouter model. The chip
  plumbing exists; needs an image content-part in the outgoing message + a model-capability
  check (only offer when the active model `supportsImages`).
- **Conversation fork.** Prompt editing already *rewinds* (`truncateMessages`); forking
  keeps both branches as separate sessions. Cheap given the JSONL `parentId`/`leafId`
  linked-list already models branches.
- **Frontmatter property tools.** `get_properties` / `set_properties` typed tools that
  read/write YAML frontmatter as structured data via `FileManager.processFrontMatter` +
  `metadataCache`, instead of the `edit` tool mutating raw text (fragile, can corrupt YAML).
  Lets the model reliably set tags/aliases/status fields. (obsidian-chat.)
- **Link-aware `rename_file` tool.** Rename/move a note via `fileManager.renameFile()` so
  Obsidian rewrites every inbound wikilink — behavior the model can't replicate with text
  edits, and which a plain write/rename would orphan. (obsidian-chat.)

### Pull-forward (re-affirmed by the bug-sweep review)

- ~~**Auto-compaction**~~ — shipped (see Cross-cutting "Context-window management"). The
  summarize-old-turns loop now runs automatically as the window fills.
- ~~**Pre-send cost estimate + hard spend cap**~~ — shipped (see Cross-cutting "Token
  budget"). Pre-send estimate in the chrome + a hard cap that blocks/aborts at the limit.

### UX polish (cheap)

- [x] **Session search/filter** in `SessionListModal` — a debounced (`filterSessions`)
      substring match over name + first message, shown once there's more than one session.
- [x] **Context-window progress bar** — a glanceable color-coded fill (`src/ui/context-bar.ts`
      `contextLevel` green/yellow/red at the 75/90% notification thresholds) in the composer
      footer, driven by the existing `getContextFraction` signal.
- [x] **Per-request `/model` override** — pick a model for the next prompt only (shift-enter /
      shift-click in the picker), then auto-revert. `AgentService.setModelOverride` applies a
      one-shot model in `modelConfigForTurn`, consumed in `runPrompt`; the model pill shows a
      "next only" badge. A stepping stone to M5 per-agent model routing.
- [x] **Tool timing + thinking indicator** — per-step elapsed time (`formatElapsed`, surfaced
      in `AssistantBubble.endStep`) and an animated agent-working spinner in the composer while
      a turn runs.
- [ ] **Up-arrow command history.** Up/Down cycles a full ring buffer of past sent messages in
      the composer (shell-style), restoring the in-progress draft at the bottom. (Desktop; mobile
      has no arrow keys — degrades harmlessly.)
- [ ] **Settings: virtual tabs.** The settings page is too long. Add a tab strip
      (General / Models / Privacy / Web / Skills & Agents / Advanced) that swaps the rendered
      group — standard community-plugin pattern, pure DOM, tabs wrap on mobile.
- [ ] **Skills as first-class slash commands.** A loaded skill is invokable directly —
      `/daily`, `/deep-research` — not only via `/skill <name>`. Built-in command names win on
      collision (the skill stays reachable via `/skill <name>`; autocomplete warns). `/skill`
      becomes the disambiguator/fallback. Auto-loaded skills already surface in the `/` popup.

### Competitive-review polish (low priority)

From the same plugin survey; lower-priority parity/reach items.

- **Mermaid + callout render parity.** Verify `AssistantBubble` renders mermaid diagrams and
  `> [!note]` callouts the model emits (Obsidian's `MarkdownRenderer` needs explicit
  post-processing for mermaid). Pure rendering parity. (pi-plugin.)
- **Editor/file context-menu "Send selection to chat".** Right-click selected text or a
  note → add it as a scoped context chip / "Chat about this note" command, via
  `editor-menu`/`file-menu` events. Low-effort UX. (obsidian-chat.)
- **Internationalization (i18n).** Externalize UI strings; most Obsidian AI plugins are
  English-only, so locales are a reach/accessibility differentiator. Independent of
  architecture. (Claudian ships 10 locales.)
- **Document ingestion (PDF/EPUB/Office) as context.** Parse non-image documents into
  attachable text. Heavier (needs parsers) and lower priority for a local-first plugin;
  PDF text extraction is the reasonable first subset. (Obsidian Copilot.)
- **Per-agent memory for subagent profiles.** Our `AGENT.md` profiles already declare a
  per-agent tool allowlist; add an optional per-profile memory scope so a persona can
  accumulate durable notes. (obsidian-ai-agents — the one part of its "markdown agents" we
  don't already have.)
