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

---

## Recommended order

B12 → E10 → F8 → A7. (Group S is a backlog for a dedicated consolidation session, not ordered.)
