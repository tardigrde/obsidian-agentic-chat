# Harness Engineering Guide — Compliance Audit

Deviation matrix mapping the principles in the [Harness Engineering Guide](https://harness-guide.com/) /
[nexu-io/harness-engineering-guide](https://github.com/nexu-io/harness-engineering-guide)
to the current `agentic-chat` harness (vault root, this repo).

**Status legend** — `compliant` matches the guide; `deviates` differs and the
deviation is intentional; `partial` covers some but not all of the principle;
`N/A` does not apply to an Obsidian plugin running inside the user's vault.

Pinned sources: site `harness-guide.com` (English) and repo `main` (no
released tag, 52 commits at audit time). The two surfaces are the same
content; conflicts are resolved in favor of the in-page article body.

This audit is the seed for follow-up work; it does not itself change any
behavior.

---

## Core Concepts

### Agentic Loop — think / act / observe cycle, turn budget, loop detection, parallel calls, streaming

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 1 | Loop is delegated to a vetted runtime, not re-implemented | `agent-service.ts` wraps `@earendil-works/pi-agent-core` `Agent` for the full ReAct loop (`agent.prompt`, `agent.steer`, `agent.abort`, `agent.waitForIdle`) | compliant | Avoids re-implementing the loop; pi-agent handles streaming, tool dispatch, message queueing |
| 2 | `max_turns` cap to prevent runaway loops | pi-agent's built-in turn/iteration cap; `enforceSpendCap` aborts in-flight runs past `costCapUsd` (`agent-service.ts:705-715`) | compliant | Cost cap is our proxy for turn cap; long-running model calls would burn spend before turns |
| 3 | Parallel tool calls in a single assistant turn | pi-agent dispatches parallel `tool_calls`; harness processes each through `AgentToolCallController` | compliant | No special-casing needed in our code; model emits parallel calls, runtime executes |
| 4 | Detect repeated-identical tool calls and escalate | Not implemented | partial | Failures are surfaced as tool results; identical-call loops rely on the model to self-correct. No `detect_loop` helper. Acceptable for short vault tasks; revisit if long-running agent mode lands |
| 5 | Stream model output token-by-token | `AgentStreamRuntime` uses `streamSimple`; UI renders incrementally | compliant | `stream-runtime.ts` |

### Tool System — registry, descriptions, MCP, composition

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 6 | Centralized tool registry with dispatch + error return | `runtime-resources.ts` composes tool sets; each tool returns string-shaped results, errors surface as tool results | compliant | Errors are returned to the model, not raised through the loop |
| 7 | Dynamic tool loading / skill menu to keep schema cost down | `ToolBudget` drops optional tools (`web_*`, `list_artifacts`, …) once schemas exceed `thresholdPercent` of context (default 2%, `tool-budget.ts:38-41`) | compliant | Variant of the skill-menu pattern: we shed optional tools by *budget* instead of by explicit `load_skill` calls |
| 8 | Tool description quality: state behavior, output format, constraints | Tool schemas in `src/tools/*-tools.ts` describe outputs, units, and limits (e.g. `read` with startLine/endLine) | compliant | Descriptions are reviewed alongside tool behavior; example-rich for vault tools |
| 9 | MCP support | `src/mcp/*` implements MCP client; per-tool server attribution via `isMcpToolName` | compliant | Stdio/transport MCP servers registered through settings; OAuth supported (`mcp/client.ts`) |
| 10 | Tool composition (sequential / fan-out / conditional) | Emerges from the loop; no harness code | compliant | Per guide, the model composes; we provide the atomic tools |

### Memory & Context — session, memory, AGENTS.md, daily logs

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 11 | Distinguish context / session / memory | Session: per-conversation JSONL via `ObsidianSessionManager`; context: built per turn by `runtime-resources.composeSystemPrompt`; memory: in-conversation only | partial | No persistent cross-session memory file outside the vault's `AGENTS.md`. The vault *is* memory; we don't add a parallel `MEMORY.md` system because notes already fill that role. **Candidate follow-up: a seamless cross-session memory layer (auto-curated MEMORY.md / daily-log writer that the harness reads at session start)** — see Cross-cutting observations |
| 12 | AGENTS.md auto-loaded as standing context | `INSTRUCTION_FILES = ["AGENTS.md","CLAUDE.md","GEMINI.md"]` (`src/agent/instructions.ts:18`); root file injected into system prompt every turn; symlink-encouraged | compliant | Matches the guide's "AGENTS.md pattern" exactly |
| 13 | Two-tier memory (daily logs + long-term MEMORY.md) | Not implemented | deviates | Vault notes replace MEMORY.md; daily log tooling would duplicate Obsidian's Daily Note plugin. Intentional scope cut — vault is the memory substrate. **Candidate follow-up: seamless cross-session memory (write Tier-1 daily notes inside the vault, distill to Tier-2 long-term memory on schedule or on demand) — see Cross-cutting observations** |
| 14 | Session persistence with serialization | JSONL per session in `.obsidian/plugins/agentic-chat/sessions/`; reload via `loadSession` | compliant | `session-manager.ts`, restored on `continueRecentSession` |

### Guardrails — trust boundary, allow/deny, tiered approval, input sanitization

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 15 | Harness is the final authority on tool execution | `AgentToolCallController.beforeToolCall` gates every call; user prompts / approval memory applied before dispatch (`tool-call-controller.ts`) | compliant | Approval is enforced in code, not in the prompt |
| 16 | Allow-list vs deny-list vs tiered approval | Tiered: `modes.ts` (plan / build / …) per-tool; per-tool approvals cached; `approval-memory.ts` remembers choices per session | compliant | Per-tool approval + per-mode policy is a tiered model |
| 17 | Sandboxing (docker / firecracker / wasm) | N/A — plugin runs in the user's existing Obsidian process; vault path-scope is the only filesystem boundary | N/A | Obsidian plugins cannot launch a sibling sandbox; isolation comes from tool scope + the user-owned vault |
| 18 | Network isolation / egress allowlist | **No domain allowlist for `fetch_url`.** Three layers: (a) `web-tools.ts` master egress gate — when off, the tools are not registered at all (`settings.ts:717`); (b) `web-fetch.ts:isBlockedHost` SSRF blocklist — rejects localhost, loopback, private IPv4 (10/8, 172.16/12, 192.168/16), link-local (169.254/16), IPv6 ULA (fc00::/7) and link-local (fe80::/10); (c) per-channel `noProxy` for the plugin/MCP/observability proxies (comma-separated hosts that *bypass* the proxy, not hosts that are allowed). MCP servers are individually user-approved. | partial | The master gate + SSRF blocklist cover the worst cases (no network, no local probing). The gap is a *positive* allowlist: when web tools are on, the agent can hit any public host. The `noProxy` field is misnamed relative to the guide's "egress allowlist" pattern — it controls proxy bypass, not destination authorization. A per-user destination allowlist for `fetch_url` (with the current SSRF blocklist as the floor) is the natural follow-up |
| 19 | Input sanitization for untrusted content (web/MCP) | `redactValue` in `privacy/redaction.ts` scrubs secrets from audit log; tool outputs return strings directly without marker wrapping | partial | We redact at the audit/observability boundary, not in the prompt itself. The system prompt warns the model to treat ignore-listed paths as nonexistent; an explicit `<tool_result>` wrapper would be a small follow-up |
| 20 | Log denied actions for debugging | `action-audit-log.ts` records `approval` events with `requested` / `approved` / `denied` decisions | compliant | Every approval gate writes a JSONL audit entry |

---

## Practice

### Context Engineering — assembly, compression, budgeting

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 21 | Priority-based context assembly | `composeSystemPrompt` orders: base prompt → mode overlay → output style → subagent system → skills listing → standing instructions | compliant | Priority order is fixed by code, not negotiated per turn |
| 22 | Tool-schema budget (priority 1, active tools only) | `ToolBudget` sheds optional tools at schema% threshold (`tool-budget.ts:1-50`) | compliant | Mirrors the guide's "only loaded skills, not all tools" rule |
| 23 | Three lines of defense: decay / threshold / active summary | Threshold compaction only: `CompactionConfig { thresholdFraction: 0.8, keepFraction: 0.3 }` (`compaction.ts:19-23`); manual `/compact`; no auto-decay window | partial | Decay is unnecessary for short vault tasks; the threshold compactor handles long sessions. No active-summarize step (no periodic checkpoint), only manual |
| 24 | Token budgeting per turn | `estimateNextCost` includes full system prompt + skills + tools; `getContextFraction` reports `0–1` fill | compliant | Readout before send (`agent-service.ts:376-378, 422-433`) |
| 25 | Re-assemble context every turn, not once | `composeSystemPrompt` runs per turn via `runtime-resources` | compliant | No stale single-shot assembly |

### Sandbox — *see row 17*

### Skill System — SKILL.md, menu, on-demand, thin harness + thick skills

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 26 | Skill = bundle of tools + SKILL.md + behavior rules | Skills directory with SKILL.md + tool/handler metadata; `formatSkillsForSystemPrompt` injects listing | compliant | `src/skills/skills.ts`, `formatSkillsForSystemPrompt` |
| 27 | On-demand skill loading via `load_skill` meta-tool | Not implemented; skills listed in the system prompt, always available | deviates | Plugin has far fewer skills than the guide assumes; menu cost is bounded. Document the intent if the skills count grows past ~20 |
| 28 | Unload mechanism | N/A — no on-demand loader | N/A | Tied to 27 |
| 29 | `unload_skill` to free context | N/A | N/A | Tied to 27 |
| 30 | Thin harness + thick skills | Harness is ~6k lines, mostly event/IO plumbing; domain logic lives in tools + skills | compliant | The split is real: `agent-service.ts` does wiring, not domain work |
| 31 | SKILL.md required for each skill | Enforced by skill loader | compliant | Skills without SKILL.md fail to load |

### Sub-Agent — leader-worker, isolated context, timeouts, no shared mutable state

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 32 | Leader delegates to workers with isolated context | `AgentSubagentRuntime.createChildAgent` builds a fresh `Agent` per child (`subagent-runtime.ts:69-80`); child tool set is pre-filtered by parent mode | compliant | Each child has its own message list; parent does not see partial child state mid-run |
| 33 | Children get only the tools the parent allows | `resolveModePolicy` + `MUTATING_TOOLS` denial (`subagent-runtime.ts:75-80`); child passes back through parent `AgentToolCallController` | compliant | Hard pre-filter; bypass requires a parent-side bug |
| 34 | Concurrency cap to prevent flooding | `defaultConcurrency: 3` (`subagent-runtime.ts:66`) | compliant | Bound matches guide's "limit depth" advice |
| 35 | Per-subagent timeout | Spend cap on parent session bounds child run cost; no per-call wall-clock timeout | partial | Cost cap is the de-facto timeout. Hard wall-clock would be a follow-up if long-running children become common |
| 36 | Sub-agents can't share mutable state | Child operates on a `ReadMemo` snapshot; parent invalidates on `vault modify` (`agent-service.ts:250-252`) | compliant | Vault is the only shared substrate, and it's user-controlled |
| 37 | Depth limit (no nested sub-agents) | `createSubagentTool` does not expose subagent recursion; profiles can't name a profile that delegates | compliant | No `subagent`-inside-`subagent` |

### Error Handling — classify, retry, degrade, escalate, checkpoint

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 38 | Classify errors (transient / permanent / model / resource) | MCP client does its own retry on `McpSessionTerminatedError` / OAuth errors (`mcp/client.ts:197-226`); agent layer does not classify broadly | partial | We handle transport-level retries for MCP; transient model-API failures surface to the user as a stream error and rely on the user-driven `retry` button. No central classifier. Cost cap covers the "resource" class |
| 39 | Exponential backoff with jitter | MCP client retry is immediate re-call after re-init; no backoff at the harness layer | deviates | Low call volume per session makes a thundering-herd unlikely; revisit if API-side throttling appears in real telemetry |
| 40 | Always return errors as tool results, never swallow | `runtime-resources.ts` and `tool-contracts.ts` enforce string-shaped results; tool errors are appended to the conversation | compliant | Model sees the error and can adapt |
| 41 | Graceful degradation / fallbacks | `tool-budget.ts` sheds optional tools rather than failing; web/MCP tools are optional; core vault tools are required | compliant | Degradation is by tool dropping, not by per-tool fallback chain |
| 42 | Human-in-the-loop escalation | Approval gate on every mutating tool; `confirmToolCall` resolves via chat UI | compliant | Guide's `EscalationLevel.CONFIRM` maps to our approval modal |
| 43 | Checkpoint / resume for long tasks | `AgentFileCheckpointRecorder` captures pre-edit file state; `AgentCompactionRuntime` rewrites the session JSONL; `truncateMessages` rewinds to a prompt boundary | compliant | `file-checkpoints.ts`, `compaction-runtime.ts`, `session-actions.ts` |
| 44 | Atomic checkpoint writes | Session JSONL append is line-oriented; compaction rewrites via the session manager's replace path | compliant | File-rename style atomicity is in `session-manager.ts` |

### Multi-Agent Orchestration

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 45 | Pipeline / fan-out / supervisor patterns | Fan-out via `subagent` tool, leader = parent agent; no pipeline or supervisor variant | partial | Fan-out is the only pattern currently used; pipeline / supervisor would require new profile types. Single-level depth is a deliberate constraint (row 37) |
| 46 | Context isolation between agents | Each child agent has its own `Agent` and message list; no shared mutable state | compliant | Achieved via separate `Agent` instances |

### Scheduling & Automation — cron, heartbeat, event triggers, isolated sessions

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 47 | Cron / one-shot timers / heartbeats | Not implemented; agent runs only when the user sends a prompt | deviates | Obsidian plugin lifecycle is foreground-driven; background timers would require a service-worker shim. Intentional scope cut |
| 48 | Isolated session per scheduled run | N/A (no scheduler) | N/A | Tied to 47 |
| 49 | Per-job model selection | Override layer in `turn-configuration.ts` (`setModelOverride`) already supports it; unused by a scheduler | partial | Primitive is in place, scheduler would consume it |
| 50 | Timezone handling (store UTC, display local) | All timestamps in audit log and sessions are ISO/UTC | compliant | `Date.now()` / `new Date().toISOString()`; the UI renders in local time via `toLocaleString` |

### Long-Running Harness Design — context anxiety, self-eval bias, reset vs compaction, gen-eval split

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 51 | Explicit context lifecycle (reset vs compaction) | Compaction only; manual `/compact`; no auto-reset | partial | Reset would be lossy for users who expect to scroll back; compaction is the chosen path. Add reset as a slash command if it becomes a recurring ask |
| 52 | Cap everything (max turns, max re-plans, max iterations) | Spend cap (`costCapUsd`) and per-session cost readout; no per-turn re-plan loop | compliant | Spend cap is the universal cap; a subagent fan-out is bounded by `defaultConcurrency` |
| 53 | Never let the generator grade its own exam | No generator/evaluator split; subagent "evaluator" is just a subagent with different tools, sharing the same model | deviates | Without a separate model role, evaluator + generator bias is real. A future `reviewer` profile or a model-routed eval would address this; not needed at current scope |
| 54 | Planner → Generator → Evaluator pipeline | Parent + subagent roughly fills the planner/generator slot; no separate evaluator | deviates | Same as 53 |
| 55 | Decomposition happens early | Parent decides whether to delegate in a single turn; no explicit planner step | partial | The model self-decomposes; works for the typical short task, weaker for true long-running pipelines |

### Managed Agents Architecture — brain/hands/session split, pets vs cattle, credential isolation

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 56 | Decouple brain (planning) from hands (execution) | Brain = parent agent; hands = subagent + tool calls | partial | The split exists but lives inside one process. True decoupling would need a worker protocol |
| 57 | Credential isolation per agent | All agents in a session share provider/key via settings; no per-agent key | partial | Multi-tenant isolation is not in scope for a single-user plugin. MCP OAuth tokens are per-server, which is the closest analogue |
| 58 | Session targeting / multi-tenant routing | N/A — single user, single vault per Obsidian instance | N/A | |

### Eval Infrastructure Noise

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 59 | Floor + ceiling enforcement to keep benchmark scores stable | Vitest smoke + `verify:fast` (`typecheck`, `lint`, `test`, `test:e2e --spec smoke`) | compliant | Stable test contract; not a benchmark but a reproducibility floor |

### Classifier-Based Permissions

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 60 | Replace approval fatigue with a model-based classifier | All approvals are explicit user clicks; no model-side classifier decides for the user | deviates | Privacy-first posture: the user stays in the loop on every mutating call. A classifier could pre-approve safe patterns; would be a follow-up feature, not a default |
| 61 | Reason-blind classifier (no chain-of-thought) | N/A (no classifier) | N/A | Tied to 60 |

### Eval Awareness

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 62 | Avoid contamination from agents recognizing eval scenarios | No eval harness inside the running agent; tests run in a separate Node process via `vitest` + `wdio` | compliant | Production agent has no signal that it is being tested |

### Agent Teams — 16-parallel-agent patterns, git worktrees, bisection

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 63 | N parallel workers coordinated through git / files | Subagent concurrency is 3, no git-coordinated fan-out, no worktree support | deviates | Vault is markdown; git worktrees for note editing are not a natural fit. Not planned |
| 64 | External oracle for evaluation | No external oracle; the model grades itself when reviewing | deviates | Tied to 53 |

### Initializer + Coding Agent Pattern

| # | Principle | Current behavior | Status | Rationale / evidence |
|---|-----------|-----------------|--------|----------------------|
| 65 | Two-phase: initializer sets up state, coding agent runs in clean context | `/init` command curates `AGENTS.md` via the normal agent loop; no separate initializer | partial | Init is a slash command, not a distinct phase. A dedicated init profile (no tools, write-only) is a possible refinement |
| 66 | Feature list / startup ritual written to disk | Not implemented | deviates | Feature lists are external to a chat plugin; no comparable artifact |

---

## Cross-cutting observations

- **Sandbox is N/A by design.** The plugin runs inside the user's Obsidian process, against a vault they already own. The trust boundary is "tool may touch only vault-relative paths" plus an ignore-list for private folders (`runtime-resources.isPathIgnored`). No sibling process to containerize.
- **Scheduling is intentionally absent.** The plugin lifecycle is foreground-driven. Background agents would need a service worker or a paired CLI; both are out of scope.
- **Long-running patterns are partial.** Compaction exists; generator/evaluator split does not. The session model assumes short- to medium-length conversations, which matches observed usage in vault note editing.
- **The guide's "thin harness + thick skills" split holds.** Most behavior lives in `src/tools/*`, `src/skills/*`, and the system-prompt overlays. `src/agent/agent-service.ts` is wiring.
- **What is missing is a README entry pointing the next reader at this matrix.** The follow-up work is to surface this file in `AGENTS.md` and to add a one-line mention in the system prompt context for the model.
- **Candidate follow-up: seamless cross-session memory (rows 11, 13).** Today the only durable cross-session signal is the user-curated `AGENTS.md` and the session JSONL (which is per-conversation, not cross-session). A Tier-1 daily log written into the vault and a distilled Tier-2 long-term file, both read at session start, would close the gap without inventing a parallel file format. The vault already hosts the substrate; the work is the read/write seam, the distillation cadence, and the read-at-startup hook. The current system-prompt slot (after the AGENTS.md overlay) is the natural injection point. **This is the highest-leverage deviation in the matrix** — every other "deviates" row is either N/A (sandbox) or out of scope (scheduling).
- **Candidate follow-up: per-user `fetch_url` destination allowlist (row 18).** The SSRF blocklist in `web-fetch.ts:isBlockedHost` is a deny-list for local/private addresses. A positive allowlist (user-configured host suffixes that `fetch_url` is allowed to reach, with the deny-list as the floor) would be a small, focused change and would close the "no positive egress control" gap. The `noProxy` field is *not* the right place — it controls proxy bypass, not destination authorization.

## Open questions

- **Pin a guide version/commit.** No `vX.Y.Z` tag exists in the upstream repo; the matrix references the article bodies, which change without notice. A `git submodule` or a vendored snapshot would make audits reproducible.
- **Single source of truth.** `harness-guide.com` and the GitHub repo are the same content as of this audit, but the site adds nav and the repo adds the EN/ZH split. We treat the article body as canon.
- **Classifier-based permissions (rows 60–61).** The privacy posture argues against silently pre-approving. A future user opt-in is the right shape.
- **Generator-evaluator (rows 53–54, 64).** Cheap to add as a profile type; deferred until a long-running task shape appears.
