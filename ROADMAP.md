# Agentic Chat — Roadmap

Only pending items. Done work is removed to keep the doc small. (B1, B2, B3a–d, B4, B5, B6, C5, F6 were completed and removed on 2026-08-01; S9 completed and removed on 2026-08-11.)

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

---

## Group B — Agent-loop correctness

### B10 · Per-edit approval within edit batches — DEFERRED
- **Problem**: A 6-edit batch was denied because user disagreed with 1 scope.
- **Assessment**: Only happened once in the audited session. B3b (partial apply on technical failure) already prevents the main pain point. A full per-edit approval UI is high complexity for rare occurrence.
- **Action**: Skip for now. Revisit if batch-denial becomes a frequent pattern.
- **Effort**: M (if ever done)

### B12 · Better grounding / intent anchoring
- **Problem**: Flash edited 6 unrelated places for a 1-section request.
- **Approach**: Weight explicit user request higher than attachment context; add synthetic focus hint.
- **Files**: `src/agent/agent-service.ts`, `src/ui/context-builder.ts`
- **Effort**: M–L

---

## Group E — Chaining timeline

### E10 · Vertical chaining timeline (per-call check/X done, line missing)
- **Problem**: Per-call check/X icons exist (`assistant-bubble.ts:366-371`) but there is no vertical run line linking the calls.
- **Approach**: ResizeObserver-driven line per assistant run.
- **Files**: `src/ui/assistant-bubble.ts`, `src/ui/chat-view.ts`, `styles.css`
- **Effort**: L

---

## Group F — Skills + MCP

### F8 · Git/FS MCP servers, connect-only, dynamic enable
- **Problem**: Want git + filesystem MCP servers; connect-only (plugin does not spawn).
- **Approach**: Add git/FS config with path; probe on load; disable (not delete) when absent; live status pill.
- **Files**: `src/settings.ts`, `src/mcp/tools.ts:85-99`
- **Effort**: M

### F9 · stdio + SSE transports for agent plugins (spec conformance)
- **Problem**: The Agent Plugins spec says a conformant client supports at least one of `stdio`/`streamable-http` and *should support both*; the `sse` transport is optional but documented. This client loads only `streamable-http` entries (everything else is skipped + reported). `stdio` is currently impossible even though the vendored schema validates `command`/`args`/`env`/`cwd` forms.
- **Goal**: Load `stdio` entries (and optionally `sse`) with the spec's command/cwd rules and `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` expansion, behind the existing approval/permission model.
- **Approach**: Subprocess transport (no Node `child_process` on mobile — desktop-gated like other host-only features); expand variables textually per spec; keep the boundary that `command` is one token; PLUGIN_DATA = plugin folder data dir.
- **Files**: `src/plugins/loader.ts` (derive stdio servers), `src/mcp/` (subprocess client), `src/settings.ts` (per-server spawn approval)
- **Acceptance**: A `stdio` plugin package appears in `/doctor`, its tools flow through approval, and the settings UI shows a connection state.
- **Open Qs**: Do we want per-server sandbox (working-dir gating) or global permission prompt? Reference `F8` for the connect-only philosophy.
- **Effort**: L
- **Deps**: S10 (state map), F8

### F10 · Skill resource loading (scripts / references / assets)
- **Problem**: Agent Skills defines `scripts/`, `references/`, `assets/` conventions and relative file references; this client exposes only the `SKILL.md` body (via `read_skill`). Skills that reference other files cannot be executed fully.
- **Goal**: On-demand loading of skill files (progressive disclosure) with relative-path resolution confined to the skill root, gated by the existing read-approval policy.
- **Files**: `src/skills/skills.ts` (skill registry + root path), `src/agent/runtime-resources.ts`, `src/tools/vault-tools.ts` (path confinement)
- **Effort**: M
- **Deps**: none

---

## Group S — Settings & feature consolidation

Status: problem inventory only. Each item documents the sprawl so a future
session can go through it one by one. Options/approaches are deliberately left
thin (or absent) here.

### S1 · Approval policy cluster
- **Problem**: `approval.mutating` (global) × per-tool overrides (two renderers write the same `perTool` map: vault tools and MCP tools) × `approval.workingDirs` (three management surfaces: settings tab, `/add-dir` + `/dirs`, composer folder menu) × MCP server-level approval (a third policy layer) × approval memory (writes into `perTool`) × the safe/yolo/plan mode overlay. Users must hold several nested layers to predict what a tool call will do.
- **Effort**: L
- **Deps**: none

### S2 · Proxy config duplicated across three subsystems
- **Problem**: `network.proxyUrl`/`noProxy`, `mcp.proxyUrl`/`noProxy`, and `observability.proxyUrl`/`noProxy` are the same shape with the same normalizers, surfaced on three separate settings tabs; MCP silently falls back to `network` when its own proxy is empty.
- **Effort**: M
- **Deps**: none

### S3 · Provider/model triple duplicated by embeddings
- **Problem**: chat and semantic retrieval each define their own provider enum + per-provider base URL/model/key triple; `EmbeddingProviderId` mirrors `ProviderId`. Two provider selectors and two model-config paths to maintain.
- **Effort**: M
- **Deps**: none

### S4 · Permission mode surfaced on four controls
- **Problem**: `settings.mode` (settings dropdown, which also lists plan) × composer Safe↔YOLO toggle × `/config` picker × `/plan` sticky read-only. Four surfaces for one value with different allowed states.
- **Effort**: S–M
- **Deps**: none

### S5 · Three ignore/deny-list mechanisms
- **Problem**: vault `ignoredGlobs`, MCP legacy tool filters (now URL params), and working directories as the inverse allow-list. Same glob syntax, three representations.
- **Effort**: M
- **Deps**: none

### S6 · Projects have no creation/edit UI; "profile" collides with output style
- **Problem**: projects mutate five settings dimensions (working dirs, output style, system prompt, model, web/mcp toggles) but can only be configured by hand-editing `data.json`; docs claim a Settings UI that does not exist. `project.profile` is literally the `OutputStyle` enum, colliding with the subagent "profile" vocabulary.
- **Effort**: L (UI) / S (rename)
- **Deps**: none

### S7 · Deprecated settings surface lingers
- **Problem**: every secret still has a dual plaintext `*ApiKey` + `*SecretId` pair with migration fallback fields persisted. (`templatesFolder` was removed in S9.)
- **Effort**: S
- **Deps**: none

### S8 · Subagent reframe: drop the "profile" concept
- **Problem**: subagents are authored as "profiles" (`AGENT.md` + built-in roster) with their own system prompt + tool allowlist, but the delegation value is isolated context for the single main agent — not a switchable persona. The "profile" vocabulary also collides with `project.profile` (an output style). The main agent should always be one agent in the main conversation; subagents are child agents that inherit the main agent's config and controls (approval, ignore list, web/MCP gates) and can be dispatched by it.
- **Approach (tentative)**: keep the child-agent runtime and the `subagent` tool; drop the `AGENT.md` profile authoring surface and built-in roster in favor of subagents that inherit from the parent (system prompt override via invocation, same tool/approval controls); possibly ship one built-in "Explorer" agent for scoped read-only tasks. Reconcile with S6 naming.
- **Effort**: M
- **Deps**: S6

### S10 · Decouple client-owned MCP state from server shape
- **Problem**: `settings.mcp.servers` persists a full *copy* of each plugin-derived server (shape + client state merged by id via `mergePluginMcpServers`/`syncMcpServers`). The package is meant to be the single source of truth for server shape, but the copy can diverge: the settings tab renders `settings.mcp.servers` while the runtime re-derives from packages per turn, and the sync/prune/merge machinery exists only to paper over that duplication. State is also keyed by derived id, so renaming a package entry or plugin loses client state.
- **Goal**: Packages define server shape; client-owned state (enabled, approval, authType/header refs, knownTools, oauth) lives in a separate id-keyed map (e.g. `settings.plugins.mcpState[id]`). Drop `syncMcpServers` and the merge; the settings tab and runtime both derive from packages + state map, so they cannot diverge.
- **Approach**: migrate the state out of `settings.mcp.servers` into the map (one-time heal), derive `McpServerSettings` on load, keep secret refs unchanged.
- **Files**: `src/plugins/loader.ts` (merge/sync removal), `src/mcp/settings.ts` (heal), `src/settings.ts` (MCP tab render), `src/agent/runtime-resources.ts`, `src/settings-schema.ts`
- **Acceptance**: editing a package's mcp.json immediately changes the UI and runtime list; toggles/approval survive package edits; no orphan-prune path remains.
- **Open Qs**: rename server key in a package — should state follow a stable "plugin:key" identity or the package-defined name?
- **Effort**: M–L
- **Deps**: none

---

## Recommended order

B12 → E10 → F8 → A7. (Group S is a backlog for a dedicated consolidation session, not ordered. S10 should precede F9 since the state map is the base for stdio server state.)
