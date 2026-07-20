# Agentic Chat — Improvement Spec

- **Status**: draft, brainstorm output. Implementation proceeds group-by-group after each group is approved.
- **Created**: 2026-07-17
- **Progress**: Group D (visual polish) implemented 2026-07-17 — see "Implementation progress" at the end.
- **Sources**:
  - User notes: `second-brain/000 Inbox/Obsidian Agentic Chat.md`
  - Session audit: `sessions/2026-07-06T07-55-24-658Z_cb89e905…jsonl` (the "PLAN.md roster tagging" run)
  - Code map of `src/` (file:line references inline)

This document is a **spec for all identified improvements**, grouped A–F. It is not an implementation order. We implement one group at a time; each group gets its own review pass before code lands. Item IDs are stable (e.g. `B3`, `D9`) so discussion can reference them.

---

## How to read each item

```
### ID · Title
- Problem:  what's wrong today, with evidence
- Goal:     desired end state
- Approach: concrete plan + alternatives considered
- Files:    code touch points (file:line)
- Acceptance: how we know it's done
- Open Qs:  decisions still needed
- Effort:   S / M / L
- Deps:     other item IDs
```

---

## Group A — Audit (research only, no code yet)

### A7 · Harness Engineering Guide compliance audit
- **Problem**: We want the harness to follow the [Harness Engineering Guide](https://harness-guide.com/) / [nexu-io/harness-engineering-guide](https://github.com/nexu-io/harness-engineering-guide), and to know where we intentionally deviate. Today there is no such audit, and the guide is not referenced in the system prompt or as a skill.
- **Goal**: A written deviation matrix (guide principle → current behavior → compliant / deviates / N/A → rationale). This matrix seeds future work (it does not itself change behavior).
- **Approach**:
  1. Fetch and read both guide sources.
  2. Enumerate the guide's principles/requirements.
  3. For each, inspect the current harness (`systemPrompt` in `data.json`, `src/agent/*`, `src/tools/*`, etc.) and record status.
  4. Write the matrix into this repo (e.g. `docs/harness-guide-audit.md`) and link it here.
  5. Scope of *later* implementation items (skill auto-presence, system-prompt entry) is derived from this audit — not specified here.
- **Files**: `src/agent/agent-service.ts`, `src/tools/*`, default `systemPrompt` in settings.
- **Acceptance**: Deviation matrix committed; each guide principle has a row; deviations have a one-line rationale.
- **Open Qs**: Which guide version/commit do we pin to? Do we treat the two sources as one canon or reconcile conflicts?
- **Effort**: M
- **Deps**: none

---

## Group B — Agent-loop correctness

This group exists to fix the *actual* failure modes observed in the audited session. The headline finding reshapes the original "model can't handle md tables" note:

> **The edit failures are not the model's fault.** A redaction layer substitutes `[EMAIL]` into the edit `oldText` args, but the on-disk file (and the `read` results shown to the model) keep the real email. The edit matcher therefore compares a redacted string against an un-redacted file and can never match. The model then loops (Alex row: 9+ attempts) and falls back to tiny prefixes that are either no-ops or too fuzzy to approve.

### B1 · Soft message queueing during a run (polish existing)
- **Problem**: User wants messages sent mid-run to queue, stick to the bottom of the message pane as pending, and be injected as a new user message after the next tool-call boundary — while prior work continues.
- **Evidence**: Soft queueing is **already implemented** — `chat-view.ts:1191 queueComposerPrompt`, `flushQueuedPromptIfReady:1197`, Send button flips to "Queue"/"Update" (`chat-view.ts:1129`). So this item is mostly **UX polish + verifying semantics**, not new plumbing.
- **Goal**: A pending message renders as a visible chip/bubble stuck to the pane bottom; it is clearly marked "queued"; on flush it becomes a real user message and the model continues the prior task (soft, not interrupt).
- **Approach**:
  1. Verify current flush fires at the right boundary (end of turn vs after next tool call — confirm "after next tool call" is feasible/desired; if the API only allows turn-boundary injection, document that and flush at turn end).
  2. Add a dedicated pending-message affordance in the pane (distinct from normal user bubbles), animated, scroll-locked to bottom.
  3. Make "Update queued message" vs "Queue another" explicit.
- **Files**: `src/ui/chat-view.ts:1129-1200`, `src/ui/assistant-bubble.ts` (pending bubble variant), possibly `src/agent/agent-service.ts` for flush hook.
- **Acceptance**: Sending while running shows a pending chip; run continues; queued text becomes a real message and is answered without losing prior context; multiple queued messages behave sensibly.
- **Open Qs**: Flush point = turn boundary (simplest, API-safe) vs mid-turn after a tool result (richer, may need turn split). **Recommended: turn boundary.**
- **Effort**: M
- **Deps**: none

### B2 · Reject no-op edits (+0/-0)
- **Problem**: `applyExactEdits` (`src/vault/edit.ts:18`) applies an edit where `oldText === newText` as a success. No-op edits waste a turn and hide "the model is confused".
- **Goal**: A no-op edit is rejected by the harness with a clear tool error, and the model is told to try differently.
- **Approach**:
  1. In the edit apply path, compute the normalized delta; if zero, return an `isError` tool result: *"Edit produced no change (oldText === newText). Re-read the current content and choose an oldText that differs from newText."*
  2. Add a unit test feeding an identical old/new pair.
- **Files**: `src/vault/edit.ts:18` (`applyExactEdits` / `resolveEdit:34`), `src/tools/vault-tools.ts:255` (`createEditTool`), tests under `test/`.
- **Acceptance**: Identical old/new returns an error, not "Applied"; test green.
- **Open Qs**: Should we also warn (not error) on a *near*-no-op (whitespace-only)?
- **Effort**: S
- **Deps**: none

### B3 · Edit robustness (md tables, mailto, partial apply, actionable errors)
This is the core fix. Split into four sub-parts because the session showed four distinct causes.

#### B3a · Stop redacting edit match arguments
- **Problem**: Redaction is applied inconsistently across layers — `read`/`file_checkpoint` expose real content, but `action_audit` (and apparently the args that reach the matcher for edits containing emails) substitutes `[EMAIL]`. The matcher then never matches. (44 `[EMAIL]` in audit-start vs 129 real emails in read results vs 252 in checkpoints, same session.)
- **Goal**: The edit matcher always compares the same bytes the model was shown. Redaction must not cross the edit-match boundary.
- **Approach (pick one, needs decision)**:
  - **(i) Exclude edit args from redaction** (recommended): pass `oldText`/`newText` to the matcher un-redacted; redact only for *display/logging*, never for matching. Matches what the model saw in `read`.
  - (ii) Redact uniformly everywhere (including reads shown to the model) so the model only ever sees `[EMAIL]`; matcher redacts the file the same way. More invasive, changes model inputs, hurts fidelity.
- **Files**: redaction layer (locate via grep on `[EMAIL]` / redaction util — audit identified the leak; the exact util needs pinpointing in implementation), `src/vault/edit.ts`, `src/tools/vault-tools.ts`.
- **Acceptance**: An edit whose `oldText` is copied verbatim from a `read` result (including `mailto:`) matches and applies on the first try. Regression test with a real mailto table row.
- **Open Qs**: Confirm approach (i) vs (ii). **Recommended: (i).** Where exactly does the redaction currently run on edit args?
- **Effort**: M
- **Deps**: none

#### B3b · Partial-apply on batch edit failure
- **Problem**: Today a multi-edit batch is atomic — one bad `oldText` fails the whole batch with `isError` and applies nothing (session: a 10-row batch died because of one Alex row). The model must re-issue the other 9 individually.
- **Goal**: Edits that match are applied; only the failing ones are reported as errors. The tool result lists per-edit outcomes (applied / not-found) and a count.
- **Approach**:
  1. Change `applyExactEdits` to apply per-edit, collect failures, and return a structured result.
  2. Tool result text: *"Applied 9 of 10 edits. 1 not found: …"*, with the failed oldText and a hint (B3c).
- **Files**: `src/vault/edit.ts`, `src/tools/vault-tools.ts:255`.
- **Acceptance**: Batch with 1 bad row applies the other 9 and reports the 1 failure. Test covers it.
- **Open Qs**: Should partial apply be gated behind a flag for users who want atomicity?
- **Effort**: M
- **Deps**: B3a (so "bad row" means genuinely bad, not redacted)

#### B3c · Actionable edit-failure messages
- **Problem**: `oldText was not found` gives the model nothing to correct with. It looped 9× on the Alex row guessing shorter prefixes.
- **Goal**: On a not-found, the tool returns the closest matching line(s) / a minimal fuzzy diff so the model corrects in one step.
- **Approach**:
  1. On not-found, run a cheap nearest-line search (Levenshtein / token overlap) over the target file.
  2. Return top 1–3 candidate lines + a one-line "your oldText differs here: …".
- **Files**: `src/vault/edit.ts`, `src/tools/vault-tools.ts`.
- **Acceptance**: A wrong oldText now returns the closest line; model self-corrects without re-reading.
- **Open Qs**: How much context to return (line + neighbors)?
- **Effort**: M
- **Deps**: B3b

#### B3d · Regression fixture: md table + mailto
- **Problem**: No test covers the exact failure surface (md table rows with `mailto:` links).
- **Goal**: A committed fixture + e2e/unit test that tags a roster row containing a mailto link, asserting first-try success after B3a.
- **Files**: `test/` (new fixture + test).
- **Acceptance**: Test red on `main` before B3a, green after.
- **Effort**: S
- **Deps**: B3a

### B4 · Deny a tool call with an optional reason
- **Problem**: `ApprovalChoice` is `{approved, remember}` only (`approval-modal.ts:12`). Denials record the generic `'The user declined this action.'` (`tool-call-controller.ts:170,227,245,252`). The real feedback ("too invasive", "line by line", "wrong line") lives only in a following free-text user message, never linked to the denied call.
- **Goal**: Deny button → optional textarea → that text is returned to the model as the tool result for the denied call.
- **Approach**:
  1. Extend `ApprovalChoice` with optional `reason: string`.
  2. Add a collapsible reason field to `ApprovalModal`; wire through `confirmToolCall` (`main.ts:199`, `tool-call-controller.ts:298`).
  3. When denied with a reason, the tool result becomes e.g. *"Denied by user: <reason>"* instead of the generic string.
- **Files**: `src/ui/approval-modal.ts:12,19`, `src/main.ts:199`, `src/agent/tool-call-controller.ts:170-316`.
- **Acceptance**: Deny → type reason → model receives it as the tool result and adjusts. Test covers reason propagation.
- **Open Qs**: Should "remember deny" also persist the reason for that tool type?
- **Effort**: S
- **Deps**: none

### B5 · Capture real tool `result.content` in audit (observability)
- **Problem**: `action_audit` end-events store `result.content` as the literal placeholder `"[content array 1 items]"`. The actual tool output is discarded, so post-hoc debugging of *why* an edit failed is impossible from the audit stream alone.
- **Goal**: Audit stores the real (but PII-redacted for display) tool result, or a faithful summary, not a placeholder.
- **Approach**:
  1. Serialize `result.content` faithfully (array items joined / truncated to a cap), redacted consistently with B3a's policy (redact for **display**, never for matching).
  2. Cap size to avoid log bloat; link to the session JSONL for full content if needed.
- **Files**: audit/observability writer (locate via grep on `[content array`), `src/agent/*`.
- **Acceptance**: Audit row for an edit contains the actual applied message / error text, not the placeholder.
- **Open Qs**: Size cap; whether to store full content in JSONL and a redacted summary in the audit UI.
- **Effort**: S
- **Deps**: B3a (shared redaction policy)

### B6 · Enforce the redundant-read guard
- **Problem**: A guard that blocks re-reading the same file fired once then was bypassed by reading different line ranges. Same file read 11× (60,969 chars re-pulled) in the session.
- **Goal**: Re-reading the same path is discouraged/blocked consistently; the model is pointed to the content already in context.
- **Approach**:
  1. Make the guard key on path (not path+range), with an escape hatch only for explicit "re-read after edit" cases.
  2. Return a helpful message pointing to where the prior content lives.
- **Files**: read tool (`src/tools/vault-tools.ts` read binding), guard logic.
- **Acceptance**: Re-reading an unchanged already-read file is blocked regardless of line range; post-edit re-read still allowed.
- **Open Qs**: Should this be a hard block or a soft warning? **Recommended: soft warning with the prior content quoted.**
- **Effort**: S
- **Deps**: none

### B7 · Session timestamp drift — RESOLVED (not a bug)
- **Finding**: Session started `2026-07-06`; the majority of the discussion/work continued `2026-07-17` (today). The 11-day gap + mid-session `model_change` is a **resumed session across days**, not mis-recorded timestamps.
- **Action**: No fix. Recorded here so it isn't re-investigated. (If resume UX should surface "resumed N days ago", that's a separate future D-item, not specced now.)

### B8 · Approval diff context lines 10 → 5 — MOVED to Group D (done)
- Visual change, regrouped into D. **Done 2026-07-17**: `DEFAULT_DIFF_CONTEXT_LINES` 10 → 5 in `src/ui/approval-modal.ts:10`.

---

## Group C — Subagent transparency

### C5 · Inline, live, collapsible subagent transcript
- **Problem**: User cannot see a subagent's full transcript; the only stop path (global stop button) is ambiguous; there's no per-subagent control. The audited session spawned 2 subagents (both aborted, 0 useful output) after the user said not to — invisibility hid that until too late.
- **Evidence**: Subagents surface today as a truncated `summary` (`assistant-bubble.ts:129 renderSubagentChildren`); launch in `subagent-tool.ts:87`; child build in `subagent-runtime.ts:34`. No transcript view, no per-child stop.
- **Goal**: Each subagent call renders an **inline, collapsible, scrollable** block in the chat showing the subagent's live activity. Plaintext with lightweight visual cues for tool calls (not the full granular tool-call chrome of the main agent, to reduce noise). A per-subagent **Stop** button. **Reasoning is hidden by default** (open question below).
- **Approach**:
  1. Reuse `startStep`/`updateStep`/`endStep` plumbing (`assistant-bubble.ts:96-154`) but render a simplified, plaintext-leaning variant for subagent children.
  2. Stream child events into the collapsible block live; auto-collapse on completion (or keep expanded if still running).
  3. Add inline `[Stop]` per running child wired to that child's abort (not the whole turn).
  4. Reject the modal approach (decided): a live transcript modal colliding with an approval modal = ugly nested modals; inline avoids that.
- **Files**: `src/tools/subagent-tool.ts:87,218`, `src/agent/subagent-runtime.ts:34`, `src/ui/assistant-bubble.ts:129`.
- **Acceptance**: Running a subagent shows its steps live inline; user can stop just that subagent; completed subagent collapses to a tidy summary; noise is lower than the main agent transcript.
- **Open Qs**:
  - **Reasoning**: show (collapsible) or omit entirely? **Recommendation needed.** Lean: omit by default, add a toggle if the subagent emits reasoning.
  - Max height before scroll? Granularity cutoff (e.g. collapse repeated identical tool calls)?
- **Effort**: L
- **Deps**: none (but benefits from B4's deny-reason for approvals inside a subagent)

---

## Group D — Visual polish (messages pane + composer)

### D9 · Tool-call box → collapsible "Details" with human-readable sections
- **Problem**: Tool-call body shows raw JSON (`{"action":"search",…}`) inline; "Result" is the only collapsible; stats (tokens/cache/cost/duration) aren't grouped with the call.
- **Goal**: A single collapsible **Details** per tool call with:
  1. **Tool call** — human-readable, few lines (not raw JSON): `vault_inspect · search content · 000 Inbox/…/PLAN.md · query: "| 11 |"`.
  2. **Result** — collapsible (current behavior, kept).
  3. Stats (tokens delta / cache % / cost / duration) — as a 3rd block **or** a hover info-icon. Stats aren't available at initial render (streaming), so the safe path is a hover info-icon populated when stats arrive.
- **Approach**:
  1. Build a human-readable summarizer per tool name (map raw args → 1–3 line description).
  2. Restructure `startStep`/`endStep` markup (`assistant-bubble.ts:96,154`) into a `<details>` with the two sections + a stats affordance.
  3. Wire per-call usage delta (see D12) into the stats affordance.
- **Files**: `src/ui/assistant-bubble.ts:96-192`, new tool-summarizer helper, `src/ui/format.ts`.
- **Acceptance**: Each tool call renders as a tidy collapsible with readable call + result; raw JSON hidden; stats visible on hover (or in a 3rd block).
- **Open Qs**: Stats as hover-icon (safe) vs 3rd collapsible block (richer, timing-risky). **Recommended: hover-icon.**
- **Effort**: M
- **Deps**: D12 (per-answer token delta) if stats include delta

### D10·E · Chaining timeline (vertical line + check/X) — *see Group E*

### D11 · Human-readable cumulative token total
- **Problem**: Big raw number `3327418 tokens` at the bottom causes anxiety.
- **Goal**: Formatted `3,327,418 tokens`; demote cumulative prominence (small/low-opacity, or behind hover) since per-answer delta (D12) is more useful.
- **Approach**: Locale-format the total in `formatUsage` (`format.ts:105`); restyle the footer container (`chat-view.ts:765 usageEl`).
- **Files**: `src/ui/format.ts:105`, `src/ui/chat-view.ts:765`, `styles.css`.
- **Acceptance**: Footer shows comma-grouped total; visual weight reduced.
- **Effort**: S
- **Deps**: D12

### D12 · Per-answer token count = delta only
- **Problem**: Per-answer token count shows cumulative/all tokens, not the new ones for that answer.
- **Goal**: Each answer footer shows `current − previous` tokens (and cache/cost deltas).
- **Approach**:
  1. Track previous totals in the view/state.
  2. `showUsage` (`assistant-bubble.ts:192`) computes and renders the delta via a new `formatUsageDelta`.
- **Files**: `src/ui/assistant-bubble.ts:192`, `src/ui/format.ts`, `src/ui/chat-view.ts:2473,2578`.
- **Acceptance**: First answer shows its own usage; later answers show only the increment.
- **Open Qs**: Show delta + cumulative small, or delta only?
- **Effort**: S
- **Deps**: none

### D13 · Cache % colored + moved right
- **Problem**: Overall cache % sits without color cue.
- **Goal**: Cache % at bottom-right, colored: `<50%` red, `<75%` amber, `≥75%` green.
- **Approach**: Add a threshold→class mapper over `cacheHitPercent` (`format.ts:74`); style classes in `styles.css`; right-align in footer.
- **Files**: `src/ui/format.ts:74,99,109`, `src/ui/chrome-state.ts:36`, `styles.css`.
- **Acceptance**: Color reflects threshold at the bottom-right.
- **Effort**: S
- **Deps**: none

### D14 · Cost projection tooltip
- **Problem**: `"$0.04 next"` is opaque.
- **Goal**: Hover tooltip explains "projected cost of the next turn".
- **Approach**: Add `title`/custom tooltip on the `next ~$X` element (`chrome-state.ts:39`).
- **Files**: `src/ui/chrome-state.ts:39`, `styles.css`.
- **Acceptance**: Hover shows an explanation.
- **Effort**: S
- **Deps**: none

### D15 · Fix execution-time text-wrap (and/or fold into Details)
- **Problem**: Duration like `81m`/`s` wraps the `s` to a new line — unpolished.
- **Goal**: No wrap (`81ms` stays one token); alternatively the duration moves into D9's Details so it's not inline at all.
- **Approach**: `white-space: nowrap` + keep unit with number on the elapsed element (`assistant-bubble.ts:154`); prefer folding into D9.
- **Files**: `src/ui/assistant-bubble.ts:154`, `styles.css`.
- **Acceptance**: No wrapped unit in any tool block.
- **Effort**: S
- **Deps**: D9 (preferred) or standalone

### D16 · De-duplicate abort/error styling
- **Problem**: Abort shows a red "Request was aborted" line **plus** an "Error" accordion repeating "Request was aborted" (`assistant-bubble.ts:186 showError` + `:164` accordion; origin string `openai-compatible-request.ts:156,501`).
- **Goal**: One clean error banner. Simple error = flat banner; only multi-line/stack-trace errors get a collapsible.
- **Approach**: Branch in `showError`: if message is short/single-line, render a flat banner and skip the accordion.
- **Files**: `src/ui/assistant-bubble.ts:164,186`, `src/agent/session-local-state.ts:26`.
- **Acceptance**: Abort shows a single banner, no nested duplicate.
- **Effort**: S
- **Deps**: none

### D17 · Tool-block chrome (background, radius, padding)
- **Problem**: Tool blocks lack consistent container styling.
- **Goal**: Subtle background, rounded corners, consistent padding on every tool block.
- **Approach**: CSS pass on the tool-call/result containers; converge with D9's new markup.
- **Files**: `styles.css`, `src/ui/assistant-bubble.ts`.
- **Acceptance**: All tool blocks share consistent chrome.
- **Effort**: S
- **Deps**: D9 (do together)

### D18 · Unified composer card + pill/toggle/toolbar polish
- **Problem**: Input area is fragmented — text box, model/search settings, action buttons live separately; pills inconsistent; Safe/YOLO toggle is blocky and loud; action icons aren't cleanly separated from input; Send not anchored bottom-right.
- **Goal**:
  - Single cohesive card holding text box + model/search settings + action buttons.
  - Uniform pills (padding, border, font) for `modelPillEl`/`projectPillEl`/`folderButtonEl` (`chat-view.ts:692,698,727`).
  - Safe/YOLO (`modeToggleEl` `:736`, `buildModeSegment :740`) → iOS-style sliding toggle or clean segmented control.
  - Action icons (New chat, History, New session, …) → low-opacity toolbar, cleanly separated from the input.
  - Send button anchored bottom-right.
- **Approach**: Restructure the composer (`chat-view.ts:687-758`) into one card; restyle pills/toggle/toolbar in `styles.css`.
- **Files**: `src/ui/chat-view.ts:687-758`, `styles.css`.
- **Acceptance**: Composer reads as one card; pills uniform; toggle slick; toolbar separated; Send bottom-right.
- **Open Qs**: iOS-slide vs segmented for Safe/YOLO? **Recommended: segmented (matches existing `buildModeSegment`).**
- **Effort**: M
- **Deps**: D19 (pills clarified same pass)

### D19 · Clarify "Vault-wide" + folder pills
- **Problem**: "Vault-wide" pill meaning unclear (isn't the tool always vault-wide?); folder-icon pill does nothing on click.
- **Goal**: Either remove redundant pills or make their function obvious and clickable.
- **Approach**:
  1. Determine from code what "Vault-wide" actually scopes (`projectPillEl`/`folderButtonEl` at `chat-view.ts:698,727` — likely retrieval/working-dir scope, not "always vault-wide").
  2. If redundant → remove. If functional → add tooltip + working click handler + clear label.
- **Files**: `src/ui/chat-view.ts:692,698,727`, `styles.css`.
- **Acceptance**: Every pill has a clear, accurate label and either works or is gone.
- **Open Qs**: (resolved during implementation once code semantics confirmed)
- **Effort**: S
- **Deps**: none

---

## Group E — Chaining timeline (hardest, risk-isolated)

### E10 · Vertical chaining timeline with per-call check/X
- **Problem**: No visual cue that long-running agent responses chain together; tool-call success/failure lives inside each box instead of on a shared timeline.
- **Goal**: A vertical line along the rightmost edge of the message pane connecting a run from its first response/tool-call after a user message to its last. Tool calls pull their check/X icons **out** of the tool box onto this line. The line **breaks at user messages** (only spans one assistant run).
- **Approach** (user-approved: ResizeObserver-driven):
  1. Render an absolutely-positioned vertical line element per assistant run.
  2. Place check/X markers per tool call on the line.
  3. Recompute line geometry on: stream updates, collapsible toggle (reasoning/details), and viewport resize — via a single `ResizeObserver` + `MutationObserver`, batched in one `requestAnimationFrame` to keep streaming snappy.
  4. Break (terminate) the line at the next user message boundary.
- **Risk**: Uncollapsing reasoning/tool details (especially mid-stream) shifts layout and can misalign a static line. The observer approach handles this; pure-CSS (e.g. column border) does not, which is why we accept the observer cost.
- **Files**: `src/ui/assistant-bubble.ts`, `src/ui/chat-view.ts`, `styles.css`, new timeline helper.
- **Acceptance**: A run shows a connected vertical timeline with check/X per tool call; line breaks across user messages; uncollapsing any block keeps markers aligned; streaming stays snappy (no dropped frames).
- **Open Qs**: Marker shape (dot vs check vs both)? Line style at breaks (fade vs hard cut)?
- **Effort**: L
- **Deps**: D9 (tool boxes restructured first), D17

---

## Group F — Skills + MCP

### F6 · Harness self-knowledge skill
- **Problem**: No skill that describes the plugin's own capabilities/limits to the agent.
- **Goal**: A skill documenting the harness's tools, constraints, and patterns; auto-present (loaded into context) so the model knows its own affordances.
- **Approach**:
  1. Author the skill (tools inventory, edit semantics incl. B2/B3 behavior, approval modes, subagent usage guidance — directly addressing the session's "spawned subagents after being told not to" failure).
  2. Register it as auto-present in the skills loader.
  3. Add a short system-prompt pointer to it.
- **Files**: skills loader (`src/skills/*` or equivalent — locate), default `systemPrompt`.
- **Acceptance**: Agent accurately describes its own tools/limits when asked; stops misusing subagents when guidance says not to.
- **Open Qs**: Should content be static or generated from the tool registry?
- **Effort**: M
- **Deps**: A7 (so guidance aligns with the audited guide), B2/B3 (so stated semantics are true)

### F8 · Git/FS MCP servers, connect-only, dynamic enable
- **Problem**: Want git + filesystem MCP servers usable for internal/external folder paths, with an explicit requirement that a server is started in the right path and an MCP config is added. (User-decided: **connect-only** — plugin assumes/expects a running server; does not spawn.)
- **Goal**: Settings let the user add a git/FS MCP server config; the plugin connects to a running server at the configured path; if the server isn't present, the config is **disabled (not deleted)** and the UI makes that state clear and easy to fix.
- **Approach**:
  1. Extend MCP server config (`settings.ts:1056 renderMcpServer`) to support git/FS server kinds with a path field.
  2. On load and on demand, probe the server (`probeMcpServer` `src/mcp/tools.ts:102`, `testMcpServer` `settings.ts:1422`).
  3. If unreachable, mark the server **disabled** (keep config), show a clear "server not running — start it at <path> then Test" state with a one-click re-test.
  4. Dynamic UX: live status pill per server (connected / disabled / error), no silent deletion.
- **Files**: `src/settings.ts:803,1056,1410,1422`, `src/mcp/tools.ts:102`, MCP config schema/types.
- **Acceptance**: Add git/FS server config → connects when running; stops cleanly (disabled, not deleted) when not; re-test brings it back; status is obvious.
- **Open Qs**: Standard server-start command surfaced in the UI (e.g. suggested `npx @modelcontextprotocol/server-filesystem <path>`)? Path allowlist for safety?
- **Effort**: M
- **Deps**: none

---

## Decisions log (resolved)

| # | Decision | Choice |
|---|---|---|
| 1 | Config source for TestVault | clickops in TestVault UI; copy `data.json` from sb vault, re-paste OpenRouter key |
| 2 | Message queueing semantics | **soft** — flush at turn boundary, prior work continues |
| 3 | Subagent transcript surface | **inline collapsible** in chat (not modal — avoids nested-modal-on-approval); plaintext + tool cues; scrollable; per-subagent Stop |
| 4 | MCP server lifecycle | **connect-only**; disable (don't delete) when server absent; dynamic settings UX |
| 5 | Timeline implementation | **ResizeObserver-driven** (accept cost; pure CSS can't handle reflow) |
| 6 | Implementation cadence | **group-by-group**, spec written for all first |
| — | Point 19 (pills) placement | moved into Group D as **D19** |
| — | Point 7 (Harness Eng Guide) placement | **audit-only** (Group A); implementation items derive from its findings |
| 8 | C5 subagent reasoning | **omit by default** (toggle only if emitted) |
| 9 | B3a redaction fix | **exclude edit args from redaction** — matcher sees what the model saw |
| 10 | B6 read guard | **soft warning** (quote prior content, don't hard-block) |
| 11 | D9 tool stats | **hover info-icon** (stats not ready at render time) |
| 12 | Batch approval | **not needed** — no batch-approval feature; denials stay per-call |
| 13 | B7 timestamp drift | **not a bug** — resumed session across days |

## Open decisions still needed

1. **B1 flush point** — turn boundary (lean) vs mid-turn after tool result?
2. **D18 Safe/YOLO** — segmented (lean) vs iOS-slide?
3. **F6 skill content** — static doc vs generated from tool registry?

## Recommended implementation order

A7 (audit) → **B** (correctness; B3a first — unblocks B3b/c/d) → C5 → D (D9+D15+D17 together, then D11/D12/D13/D14/D16/D18/D19) → E10 → F6/F8.

B3a is the single highest-leverage fix — it alone would have prevented the entire 23-edit-session failure loop.

---

## Implementation progress

### Group D — visual polish ✅ (landed 2026-07-17)

All five sub-passes implemented, verified (`typecheck` + `lint` + 1132 unit tests + esbuild + mobile-compat all green), built into TestVault.

| Pass | Items | Outcome |
|---|---|---|
| D-1 | D9 + D15 + D17 | Tool step is one collapsible `<details>`: summary = status icon + human-readable label + elapsed time (nowrap); body = readable "Tool call" section (no raw JSON) + "Result" section. Subtle bg, rounded, padding. **Refinements**: per-tool call rendering — read = "Read [path·clickable]" + line range, **Result hidden on success** (file is local/in context); write = "Wrote [path·clickable]"; edit = clickable path + N edits + **mini oldText(−)/newText(+) diff** from the args (the change itself — no file context available at render time, unlike the approval modal's full contextual diff). Paths are clickable vault links (`onOpenNote` → `openLinkText`). |
| D-2 | D11 + D12 | Cumulative locale-formatted (`3,327,418`). Per-answer footer = **delta** vs previous turn (`formatUsageDelta`). |
| D-3 | D13 + D14 | Cache % colored (<50 red / <75 amber / ≥75 green) via `cacheHitTone`; "next ~$X" hover tooltip. |
| D-4 | D16 | Root cause of the persistent duplicate: two paths fired on abort — `finalizeBubble`→`showError` (banner) AND `showServiceError()` (chat-view.ts:1370, post-`sendPrompt`)→`renderErrorPanel` (open "Error" `<details>`). Fix: bubble banner is canonical; `showServiceError` skips the panel when the error matches the just-shown bubble error (`lastBubbleError`, reset per turn). `showError` also branches (flat for short, collapsible for traces) and is idempotent. |
| D-5 | D18 + D19 | Folder button → pill chrome. D18 was already largely implemented by a prior refactor (one `agentic-chat-field` card, low-opacity header actions, segmented Safe/YOLO). **Decisions**: vault pill → hide when no project configured (TODO); folder menu → popover at pill (TODO). |

### D follow-ups (same session)

- **D-1 v3 — chevron toggle + clickable title path**: step is now a *manual* collapsible (dropped native `<details>`). Header = [chevron toggle] [status icon] [label + clickable vault path] [elapsed]. Only the chevron collapses/expands, so clicking the path link opens the note without toggling. Chevron auto-hides when the body has nothing to expand. `write`/`read`/`get_active_note` success results hidden (file is local/in context). Edit body = N edits + mini oldText(−)/newText(+) diff.
- **D-6 — vault pill + folder popover** (the two decisions above, now done): project pill hidden until a project exists (`syncProjectPill` `toggle(!!project)`); folder pill click opens an Obsidian `Menu` popover anchored at the button (`attachFolderMenuItems`) instead of a chat action card.
- **B8 (moved here from B, done)**: approval diff context 10 → 5.

**D9 deferred sub-decision**: per-tool-call token/cache/cost stats via hover info-icon are **not implemented** — the data model carries usage per assistant *message*, not per tool *call*, so the plumbing doesn't exist yet. Implemented the user's explicit fallback (Tool call + Result sections only). Revisit when per-call usage is tracked.

**D19 findings (no code change — needs dogfood confirmation)**:
- `projectPill` ("Vault-wide") is the **project switcher**, not a vault-scope indicator. Label `"Vault-wide"` (`projects.ts:102`) means *no active project* (whole vault); a project can scope folders/model/profile. Functional + already has an explanatory tooltip → kept as-is. Answer to "do we need that?": yes, for project switching.
- `folderButton` → `showFolderMenu()` **does** build a "Folders" action card (working-dir / attach) via `renderer.actionList`. "Click does nothing" is most likely the card rendering in the chat transcript (easy to miss) rather than a dropdown at the pill — **confirm in TestVault**, then decide whether to surface it as a popover instead. Not changed blind in a visual pass.

### Deferred / next
- **Group B** (esp. B3a redaction-match fix + B3b partial-apply, bundled in one `edit.ts` pass) — highest leverage.
- **Group A7** (Harness Eng Guide audit) — research.
- **Group C5** (inline subagent transcript), **E10** (timeline), **F6/F8** (skill + MCP).
- D9 hover-icon stats (needs per-call usage plumbing).
