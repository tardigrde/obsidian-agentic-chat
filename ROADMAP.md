# Agentic Chat — Roadmap

Only pending items. Done work is removed to keep the doc small. (B1, B2, B3a–d, B4, B5, B6, C5, F6 were completed and removed on 2026-08-01; S9 completed and removed on 2026-08-11; E10 completed and removed on 2026-08-24 — beautifului polish #98; S2/S3 completed and removed on 2026-08-28 — proxy + provider consolidation #108; H4 completed and removed on 2026-08-28 — per-subagent wall-clock timeout already shipped; H1 completed and removed on 2026-08-28 — fetch_url allowlist #110; H7 completed and removed on 2026-08-28 — tool-output wrapper #111; B12 completed and removed on 2026-08-28 — intent anchoring #113; H3 completed and removed on 2026-08-28 — error classifier #112; F10 completed and removed on 2026-08-28 — skill resource loading #114; H8 completed and removed on 2026-08-28 — on-demand skill loading #115; R1 completed and removed on 2026-08-28 — subagent replay #116; S10 completed and removed on 2026-08-28 — MCP state decoupled #S10; S1 completed and removed on 2026-08-29 — approval lattice #121; S4 completed and removed on 2026-08-29 — permission mode consolidation.)

- **Status**: living document
- **Created**: 2026-07-17

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

## Group A — Audit

### A7 · Harness Engineering Guide compliance audit
- **Problem**: No audit of how the harness aligns with the [Harness Engineering Guide](https://harness-guide.com/).
- **Goal**: Deviation matrix committed; each principle has a row.
- **Effort**: M
- **Deps**: none
- **Codex**: No formal deviation matrix in `/tmp/opencode/codex`; closest is `docs/harness-guide-audit.md` deviation table already in this repo. Can borrow Codex protocol as reference harness (`codex-rs/protocol`) — its `AskForApproval`/`SandboxPolicy`/`PermissionProfile` lattice is a mature example to score against, but no direct copy.

---

## Group B — Agent-loop correctness

### B10 · Per-edit approval within edit batches — DEFERRED
- **Problem**: A 6-edit batch was denied because user disagreed with 1 scope.
- **Assessment**: Only happened once in the audited session. B3b (partial apply on technical failure) already prevents the main pain point. A full per-edit approval UI is high complexity for rare occurrence.
- **Action**: Skip for now. Revisit if batch-denial becomes a frequent pattern.
- **Effort**: M (if ever done)

*B12 · Better grounding / intent anchoring — **DONE** in #113.* `src/ui/context-builder.ts` `FOCUS_HINT`/`buildFocusHint`/`assemblePrompt`/`escapeContextSection` + `src/ui/chat-view.ts` `assemblePrompt` injection between `<context>` and request + `src/ui/composer-input.ts` `stripContextPreamble` delegation + `src/agent/default-system-prompt.ts` hierarchy (`system > Focus > request > <context>`/tool outputs). Hint is static (no echo of user text) and `<context>` forgery (`</context>`/`<context>`/`Focus:` inside attachments) is escaped. Harness over-edit gap closed.

---

## Group E — Chaining timeline

*E10 · Vertical chaining timeline — **DONE** in #98.* Per-turn `ResizeObserver`-driven rail (`assistant-bubble.ts:99-217` `ensureTimeline` / `updateRail`, `styles.css:458` `.agentic-chat-timeline-rail`) now links reasoning + tool steps. Check/X per-call icons remain (`assistant-bubble.ts:590`). No pending item.

---

## Group F — Skills + MCP

### F8 · Git/FS MCP servers, connect-only, dynamic enable — DEFERRED (low demand, already possible via generic MCP)
- **Problem**: Want git + filesystem MCP servers; connect-only (plugin does not spawn).
- **Approach**: Add git/FS config with path; probe on load; disable (not delete) when absent; live status pill.
- **Files**: `src/settings.ts`, `src/mcp/tools.ts:85-99`
- **Effort**: M
- **Note**: Generic `mcp__` Streamable HTTP already covers this; no dedicated preset needed now. Pushed behind stability/consolidation items.

*F10 · Skill resource loading — **DONE** in #114.* `read_skill_file` with skill-root confinement (`src/skills/skills.ts` + `src/tools/vault-tools.ts`), `src/agent/runtime-resources.ts` progressive disclosure. `scripts/`/`references/`/`assets/` now loadable.

---

## Group S — Settings & feature consolidation

Status: problem inventory only. Each item documents the sprawl so a future
session can go through it one by one. Options/approaches are deliberately left
thin (or absent) here.

### S1 · Approval policy cluster
- **Problem**: `approval.mutating` (global) × per-tool overrides (two renderers write the same `perTool` map: vault tools and MCP tools) × `approval.workingDirs` (three management surfaces: settings tab, `/add-dir` + `/dirs`, composer folder menu) × MCP server-level approval (a third policy layer) × approval memory (writes into `perTool`) × the safe/yolo/plan mode overlay. Users must hold several nested layers to predict what a tool call will do.
- **Effort**: L
- **Deps**: none
- **Codex**: Mature lattice to borrow: `AskForApproval` (`Never|OnRequest|UnlessTrusted|Granular`) `codex-rs/protocol/src/protocol.rs:963,988` + `SandboxPolicy` (`DangerFullAccess|ReadOnly|WorkspaceWrite|External`) `protocol.rs:1049` → `PermissionProfile::Managed|Disabled|External` `models.rs:414` + per-server/tool `McpServerConfig.tools` `mcp_types.rs:74,233` with `AppToolApproval::Auto|Prompt|Writes|Approve` + `restrict_to` merging, and `CollaborationMode::Plan|Default` `config_types.rs:673`. Replace flat `allow/ask/deny` with `Granular` + `PermissionProfile`; unify MCP/App tool approval via same enum.

*S2 · Proxy config — **DONE** in #108.* `src/network/proxy.ts` owns `ProxySettings` + `effectiveProxy()`, `src/settings.ts:renderProxySettingRows` deduped. Persisted `data.json` unchanged. Reverted from pending 2026-08-28.

*S3 · Provider/model triple — **DONE** in #108.* `EmbeddingProviderId = ProviderId`, `PROVIDERS`/`healProviderId()` centralized in `src/llm/models.ts`. Labels stay separate.

*S4 · Permission mode surfaced on four controls — **DONE** (this PR).* `src/agent/modes.ts` `validateModeTransition`/`resolveModeTransition` is the single gate (mirrors Codex `ThreadSettingsOverrides` atomic apply); `src/settings.ts` dropdown now lists `MODE_ORDER` (Safe/YOLO/Plan) and delegates via `plugin.requestModeChange` to the active `ChatView` so `modeBeforePlan` stays coherent; `src/ui/chat-view.ts` `setMode` + `isAnyTabStreaming` centralizes all four surfaces (settings dropdown, composer Safe↔YOLO toggle, `/config` picker, `/plan` sticky); `src/main.ts` `modeBeforePlan` singleton + `syncModeToViews` broadcasts to every leaf; `src/ui/commands.ts` `/config` lists Safe/YOLO/Plan. Single source, all UIs reflect it.

*S5 · Three ignore/deny-list mechanisms — **DONE** (this PR).* `ignoredGlobs` → `FileSystemDenyReadPattern` + `PROTECTED_METADATA_PATH_NAMES` via `src/vault/file-system-sandbox.ts` + `src/vault/glob-pattern.ts` + `src/vault/ignore.ts` (protected `.obsidian`+`.git`+`.trash` always denied, user globs merged, case-insensitive subtree, NFC, ReDoS cap, vault caps 200/200); `workingDirs` → `SandboxPolicy::WorkspaceWrite.writable_roots` docs in `src/agent/working-dir.ts`; MCP `enabled_tools/disabled_tools` ordered allow-then-deny via `src/mcp/tool-filter.ts` (glob `*`/`**`/`?`, MAX 100/200, dedupe, heals camel/snake, `iu` flag) filtered in both `probeMcpServer` and `discoverServerTools`; runtime `src/agent/runtime-resources.ts` uses `createFileSystemDenyMatcher` with vault `configDir`; settings UI adds per-server textareas. Tests cover heal, matcher, ordering, ReDoS, NFC, subtree/case.

*S7 · Deprecated settings surface lingers — **DONE** (this PR).* `settingsForStorage` (`src/secrets/secret-store.ts` `storeSecretSlot`/`storeSettingsSecretSlot` via shared `parentOf` + `deletePath`) now omits all 10 plaintext secret keys from persisted `data.json` entirely (never `""`); secrets live only in secretStorage via `*SecretId` refs. Runtime plaintext fields stay for `apiKeyForProvider`/legacy migration (marked `@deprecated` in `src/settings-schema.ts`, `src/mcp/settings.ts`, `src/observability/settings.ts`). Return type is `PersistedSettings` (plaintext optional) so stored JSON must not be reused as runtime. Tests cover omission (`test/secret-store.test.ts`) + legacy→save→reload→hydrate round-trip.

### S8 · Subagent reframe: drop the "profile" concept
- **Problem**: subagents are authored as "profiles" (`AGENT.md` + built-in roster `src/agent/subagents.ts:49` + `agentsFolder`/`enableBuiltinAgents` `src/settings-schema.ts:77`) with their own system prompt + tool allowlist, but the delegation value is isolated context for the single main agent — not a switchable persona. The "profile" vocabulary also collides with `outputStyle` (`src/agent/output-styles.ts:6` `default/brainstorm/learning`).
- **Clarification 2026-08-24**: #102 `feat/remove-projects` removed the *projects* `profile` (`projects[].profile` → per-project output style), not subagent profiles. Subagent `AgentProfile` and `outputStyle` both remain; this item is **still open**.
- **Approach (tentative)**: keep the child-agent runtime and the `subagent` tool; drop the `AGENT.md` profile authoring surface and built-in roster in favor of subagents that inherit from the parent (system prompt override via invocation, same tool/approval controls); possibly ship one built-in "Explorer" agent for scoped read-only tasks.
- **Effort**: M
- **Deps**: none
- **Codex**: Roles not profiles: `AgentRoleConfig{description, config_file, nickname_candidates}` `agent_role_config.rs:10`, declared as `[agents.<name>]` table or `agents/*.toml` files `loader.rs:75`/`discovery.rs:7`, `config_file` is a full `ConfigToml` overlay `agent_role_config.rs:27` merged via `merge_missing_role_fields` `loader.rs:166`. Borrow: rename `profile→role`, support both inline `[agents.*]` and `agents/*.toml` roster, `role.config_file` inherits parent and overlays — matches S8 intent verbatim.

*S10 · Decouple client-owned MCP state — **DONE** in #S10 (this PR).* `mcp.json` is now shape SSOT (`url/name/headers/source/pluginRoot` `src/plugins/loader.ts:293`), client state (`enabled/approval/auth/knownTools/oauth/lastUrl`) lives in `settings.plugins.mcpState[id]` (`src/mcp/settings.ts` `McpServerState` + `src/plugins/settings.ts` `mcpState` + `src/settings-schema.ts` heal+migration). `src/plugins/loader.ts` `deriveMcpServers`/`resolveMcpServers` derive runtime list without `mergePluginMcpServers`/`syncMcpServers` divergence; `src/agent/runtime-resources.ts` and `src/settings.ts` MCP tab both derive from `plugins + mcpState`; `src/secrets/secret-store.ts` handles `mcpState` secrets; URL-change clears tokens (`lastUrl` check) and orphans are pruned. Every MCP is now an Agent Plugin (`plugin.json + mcp.json`) even if no skills — fully standardized.

---

## Group H — Harness gaps (first-principles audit follow-ups)

Derived from `docs/harness-guide-audit.md` deviation matrix + vault-owned agent first principles. Each item closes a `partial`/`deviates` row where the guide's pattern applies to an Obsidian plugin.

*H1 · `fetch_url` destination allowlist — **DONE** in #110.* `settings.web.allowedHosts` (`src/tools/web-allowlist.ts` / `src/settings-schema.ts:138` / `src/settings.ts:Web tab` / `src/tools/web-fetch.ts`) enforces label-boundary-aware suffix match (`example.com` → `sub.example.com` ok, `evil-example.com` blocked) after `isBlockedHost` (deny wins), including redirect hops. Empty = allow all public. UI normalizes on save; tests cover `normalizeAllowedHosts`/`isHostAllowedByAllowlist`, `*` wildcard, SSRF deny-wins, redirect block. Harness #18 gap closed.

### H2 · Seamless cross-session memory (Tier-1 daily + Tier-2 distilled) — DEFERRED (big feature, not now)
- **Problem**: Only durable cross-session signal is hand-curated `AGENTS.md` + per-conversation JSONL. No automatic Tier-1 daily log nor Tier-2 long-term MEMORY distilled file. Harness #11 `partial` / #13 `deviates`. JTBD "remember across sessions without me curating" unmet.
- **Decision 2026-08-28**: **Postponed** — new big feature, needs vault file lifecycle + privacy docs. Keep design here, implement later.
- **Design (when built):**
  - **Off by default**, `Settings → Agent → Memory [ ] Enable vault memory` with short note: `When on, writes daily summaries to memory/daily/ + distilled memory/MEMORY.md in your vault (plain Markdown, synced like any note). Both auto-loaded into every new chat. May contain session summaries — review before sharing vault. Costs ~500-800 tokens/chat.` Links to `docs/features/memory.md` (full page: where files live, when it runs, what's sent to model, redaction limits, how to review/delete, how to disable).
  - **No `/memory distill` friction — fully automated:** Tier-1 appends on session end (debounced 30s after last turn) to `memory/daily/YYYY-MM-DD.md` (redacted via `privacy/redaction.ts`). Tier-2 auto-consolidates without command: (a) idle debounce 2-5min after Tier-1 if `MEMORY.md` >24h old or >3 new Tier-1 entries, (b) on vault open before first prompt if pending, (c) weekly fallback. `/memory distill` stays as manual `distill now` only. Only consolidation path may write `MEMORY.md` — deny generic `write`/`edit` even in YOLO + subagents; Tier-2 read-only otherwise.
  - Alternative `MEMORY.md` in plugin folder — rejected, vault is memory substrate.
- **Files**: `src/agent/instructions.ts` (load slot, truncate `2500t`), `src/agent/runtime-resources.ts` (`composeSystemPrompt` order), `src/session/session-manager.ts` (hooks, idle timer, startup check), `src/tools/memory-tools.ts` (distill, manual trigger), `src/privacy/redaction.ts`, `src/agent/tool-call-controller.ts` (write boundary), `src/settings.ts` (toggle + note), `docs/features/memory.md`
- **Acceptance**: Enable → next session end writes redacted `daily/`; idle consolidates to `MEMORY.md`; two sessions on different days: second prompt contains distilled facts; generic `write memory/MEMORY.md` denied even in YOLO; disable stops writing/loading.
- **Effort**: M–L
- **Deps**: none
- **Codex**: Borrow but vault-adapt the two-phase pattern (`memory_summary.md v1 2500t` + `MEMORY.md` handbook + `rollout_summaries`); adapt to vault paths and redaction. See previous revision for full Codex file map.

*H3 · Central error classification + exponential backoff — **DONE** in #112.* `src/agent/error-classifier.ts` (`classifyError`/`classifyHttpResponse`/`backoffDelayMs` 500ms→8s+jitter, `Retry-After` capped `60s`, `secureRandom` via `crypto.getRandomValues`), `src/agent/stream-runtime.ts` + `src/mcp/client.ts`/`src/mcp/fetcher.ts` bounded retry (transient 408/409/425/429/5xx, permanent 401/403/404 never retry, `resource`/`aborted`/`model` never retry). Harness #38/#39 gap closed.

*H4 · Per-subagent wall-clock timeout — **DONE** (already shipped).* `settings.subagentTimeoutSeconds` enforced via `AbortController` + `setTimeout(healSubagentTimeout)` in `src/tools/subagent-tool.ts:271`, surfaced as `Timed out after Ns` / `aborted` not `error`. `0` disables, max `86400` `src/settings-schema.ts:271`. Harness #35 gap closed.

### H5 · Generator-evaluator split (model-routed review)
- **Problem**: Reviewer subagent shares same model as generator; no separate eval arm. Harness #53-54 `deviates` / #64. Vault edits not independently graded.
- **Goal**: Optional evaluator routing: `/deep-research` adversarial reviewer pass + future `reviewer` profile can target cheaper/stronger model via `AgentProfile.model` override, distinct from generator model.
- **Approach**: Keep current reviewer prompt; add `model` field use in `subagent-runtime.ts:69` already supports fallback. Add settings-level `reviewerModel` or reuse per-profile `model` + documentation. Long-term: pipeline `planner→generator→evaluator` as skill, not harness core. **Note**: S8 proposes dropping `AgentProfile` persona vocabulary — keep `model` override even if roster shrinks to single `Explorer` (inheritance + per-invocation model).
- **Files**: `src/agent/subagents.ts` (REVIEWER_PROMPT), `src/agent/subagent-runtime.ts`, `docs/` (`/deep-research` skill)
- **Acceptance**: Researcher→Reviewer→Synthesis run uses two different model ids when reviewer profile specifies `model`; synthesis cites reviewer findings severity-ordered.
- **Effort**: S
- **Deps**: H2 (memory helps evaluator context)
- **Codex**: Two reviewer patterns to borrow: (1) `/review` sub-agent `ReviewTask` `tasks/review.rs:99` with `REVIEW_PROMPT=rubric.md:3` (P0-P3 priorities, `findings[]{title≤80ch, body, confidence, priority, code_location}` JSON `rubric.md:71`) → `parse_review_output_event` `review.rs:193` + `model=review_model ?? parent` `review.rs:123` + `approval=Never` `WebSearch|Collab` disabled; (2) `GuardianReviewSession` `guardian/review_session.rs:92` with `ReuseKey` hashed by model/provider/window, `auto_review_model_override` `model_info.rs:183`. Plus generic `spawn_agent{message, task_name, model, reasoning_effort, fork_turns}` `spawn.rs:274` + `apply_requested_spawn_agent_model_overrides` validated against `models_manager` `multi_agents_common.rs:264` + role-locked `AgentRoleConfig` `role.rs:51` (explorer/worker). Borrow: `REVIEWER_PROMPT` → JSON schema like Codex rubric, `subagent` tool accept `model`/`reasoning_effort` with `agent_default_subagent_model` validation, reviewer defaults to cheaper model.

*H6 · Loop detection — **DROPPED** 2026-08-28.* Weak-model artifact (deepseek v4 flash 3× identical `read`); not seen with current `kimi-k2.6` + `B12` grounding/`H7` wrapper. Codex has none (only `guardian_rejection_circuit_breaker` `service.rs:69`). `Effort S`, no auto-abort, low harm but low ROI — models only improve. Revisit if identical-tool loops reappear.

*H7 · Tool-output sanitization wrapper + marker — **DONE** in #111.* `src/tools/tool-output-wrapper.ts` (`TOOL_OUTPUT_BEGIN_PREFIX`/`TOOL_OUTPUT_END_MARKER` with `TOOL_OUTPUT_*_ESCAPED` escaping of inner marker sequences) wraps `textResult`/`untrustedTextResult` (vault), `mcp` (`renderMcpResult` incl. `structuredContent`), `fetch_url`/`web_search` with `[BEGIN_UNTRUSTED_TOOL_OUTPUT ...]/[END_UNTRUSTED_TOOL_OUTPUT]` and `unwrapToolOutput` helper for tests. System prompt (`src/agent/default-system-prompt.ts`) states content inside markers is untrusted DATA, never instructions. Injection payload text (`Ignore previous instructions`, `</TOOL>`, fake `tool_call` JSON) stays as data inside the wrapper; only inner `BEGIN`/`END` sequences are escaped. Harness #19 gap closed.

*H8 · On-demand skill loading — **DONE** in #115.* `load_skill`/`unload_skill` harness tools swap body into `runtimeResources` layer (`src/tools/skill-tools.ts`, `src/skills/skills.ts`, `src/agent/runtime-resources.ts`), `name+desc` listing only (~200 tok overhead for 20 skills). F10 confinement reused.

---

## Group C — Context & compaction

### C6 · Context stability — threshold + manual only (auto-decay removed)
- **Problem**: Only threshold compaction (80% `compaction.ts:19`) + manual `/compact`; no auto-decay window. Harness #23 `partial` / #51 `partial`.
- **Decision 2026-08-28**: Auto-decay (`>40 msgs && <80% → compact oldest 20%`) **removed** — surprise/lossy rewrite at 60% without user consent violates least-surprise; no mature harness does it (Codex `context_window.rs:7` + `turn.rs:1033` token-only, `token_budget.rs:71` hint only; `pi-agent-core` threshold-only). Keep hard `80%` (`compaction.ts:84`) + manual `/compact` (`compaction-runtime.ts:177 force`) as the two lines; do not babysit.
- **Approach if needed later**: Lightweight **reminder only** (not auto-compact) in `compaction-orchestrator.ts`/`/status`: if `msgs>40 && tokens<80%` show `Long session — consider /compact` once per 10 msgs, gated by `compaction.enabled`. No auto-rewrite. Alternative `reset` slash rejected — lossy scrollback per audit. Periodic checkpoint is `H2` vault memory, not compaction.
- **Files**: `src/agent/compaction.ts`, `src/agent/compaction-orchestrator.ts` (hint only, if built), `src/agent/compaction-runtime.ts` unchanged
- **Acceptance**: 50-turn @60% does **not** auto-compact; `/status` may show hint, threshold @80% still compacts at user boundary. No surprise summary.
- **Effort**: S if hint built, otherwise removed
- **Deps**: none
- **Codex**: No decay to borrow — token window is `ContextWindowTokenStatus` `context_window.rs:7` (`Total` vs `BodyAfterPrefix` via `prefill_baseline` `auto_compact_window.rs:22` + `buffered_limit` `context_window.rs:97` + `AutoCompactWindow` `auto_compact_window.rs:34` + pre/mid/manual triggers `turn.rs:1033`/`should_roll_over`). Could borrow `prefill_baseline`+`buffered_limit`+`once-per-window` for threshold accuracy, but not auto-decay; `history-notes` `ext/history-notes` is `H2` analogue.

---

## Group R — Resilience & UX polish

*R1 · Persist subagent dispatch summary + replay — **DONE** in #116.* Structured `details` attached to assistant message (`src/agent/subagent-runtime.ts` → `src/session/session-manager.ts` → `src/ui/assistant-bubble.ts`), rehydrated as collapsed dispatch card on reload without re-running. `persistedSnapshot` strips `transcript`/`stopId` for JSONL.

### R2 · Approval diff polish — per-edit preview
- **Problem**: Batch `edit` approval shows aggregated diff; user cannot allow 5 of 6 edits (B10 deferred, rare but high frustration when it hits).
- **Goal**: Keep single approval gate for batch (avoid S-sprawl), but show per-edit diff sections so deny is informed. Partial apply already ships (`src/tools/vault-tools.ts:292`), UI just needs to surface it.
- **Approach**: `edit-preview.ts` already builds preview; `approval-modal.ts` renders per-edit hunks with checkboxes read-only (info only). No per-edit allow — keeps gate simple.
- **Files**: `src/agent/edit-preview.ts`, `src/ui/approval-modal.ts`
- **Acceptance**: 6-edit batch approval dialog lists 6 hunks, each labeled `+line/-line`. Approve still applies all; deny applies none. No new approval-memory keys.
- **Effort**: S
- **Deps**: none
- **Codex**: Aggregated diff only: `ApplyPatchApprovalRequestEvent{changes: HashMap<PathBuf, FileChange>}` `approvals.rs:423` (`Add|Delete|Update{unified_diff}` `protocol.rs:4077`) rendered via `create_diff_preview` ≤`PREVIEW_ROWS=12`/`64KiB` `diff_render/preview.rs:14` + `create_diff_summary` full pager `diff_render.rs:366` with `DiffTheme` syntax highlight `diff_render.rs:126`. No per-edit gate — we are ahead. Borrow: `PREVIEW_ROWS`+`visible_byte_count` budget, `wrap_styled_spans` tab-width handling, per-file `+a/-d` header `diff_render.rs:423`.

---

## Recommended order

**Stability first:** `H5 → R2 → A7` (`C6` auto-decay removed, `H6` dropped, `H2` deferred — big feature).

(Group S `S1-S10` remains a dedicated consolidation session, not ordered — **S10 done**, **S1 done** (#121), **S4 done** (#122), **S5 done**, **S7 done** (this PR), next `S8`. `H3` done #112, `F10` done #114, `H8` done #115, `R1` done #116, `S10` done #S10, plus `B12` done #113, `H1` done #110, `H4` done, `H7` done #111, `S2/S3` done #108, `E10` done #98. `F8` + `H2` + `C6/H6` deferred/dropped.)

*First-principles rationale*: security/reliability done — next small wins are evaluator routing (`H5` `S`) then diff polish (`R2` `S`) before audit (`A7`). Memory (`H2`) is `M–L` and needs docs/privacy pass, so pushed. No babysitting — user controls `/compact`, threshold `80%` is the safety net. S-cluster high-ROI but `L-effort` and cross-cuts every gate, so batch separately. `H5` reuses `AgentProfile.model` — reconcile with `S8` role reframe.

*Codex borrow summary*: `C6` no auto-decay; `H6` dropped; `H2` deferred but design kept (auto Tier-1 + idle Tier-2, off by default); `H5` `review_model`+rubric JSON+`spawn_agent` routing; `R2` preview budget/highlight; `S` copy Codex lattices.
