# Agentic Chat — Roadmap

Only pending items. Done work is removed to keep the doc small. (B1, B2, B3a–d, B4, B5, B6, C5, F6 were completed and removed on 2026-08-01.)

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

## Recommended order

B12 → E10 → F8 → A7.
