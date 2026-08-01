# Agentic Chat — Roadmap

Only pending items. Done work is removed to keep the doc small.

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

### B1 · Soft message queueing during a run (polish existing)
- **Problem**: Queueing exists (`chat-view.ts:1191`) but needs UX polish — pending chip, flush semantics.
- **Effort**: M

### B2 · Reject no-op edits (+0/-0)
- **Problem**: `oldText === newText` returns success. Wastes a turn.
- **Files**: `src/vault/edit.ts:18`, `src/tools/vault-tools.ts:255`
- **Effort**: S

### B3 · Edit robustness (md tables, mailto, partial apply, actionable errors)

#### B3a · Stop redacting edit match arguments
- **Problem**: `[EMAIL]` in edit `oldText` vs real content in `read` → matcher never matches.
- **Approach**: Exclude edit args from redaction; redact only for display/logging.
- **Files**: redaction layer, `src/vault/edit.ts`, `src/tools/vault-tools.ts`
- **Effort**: M

#### B3b · Partial-apply on batch edit failure
- **Problem**: One bad row kills a 10-edit batch.
- **Approach**: Apply per-edit, return structured result.
- **Files**: `src/vault/edit.ts`, `src/tools/vault-tools.ts:255`
- **Effort**: M
- **Deps**: B3a

#### B3c · Actionable edit-failure messages
- **Problem**: `oldText was not found` → model loops guessing.
- **Approach**: Return closest matching line(s) via cheap fuzzy search.
- **Effort**: M
- **Deps**: B3b

#### B3d · Regression fixture: md table + mailto
- **Problem**: No test covers the exact failure surface.
- **Effort**: S
- **Deps**: B3a

### B4 · Deny a tool call with an optional reason
- **Problem**: Denials are generic `"The user declined this action."`.
- **Approach**: Add optional `reason: string` to `ApprovalChoice`.
- **Files**: `src/ui/approval-modal.ts:12`, `src/main.ts:199`, `src/agent/tool-call-controller.ts`
- **Effort**: S

### B5 · Capture real tool `result.content` in audit
- **Problem**: Audit stores `"[content array 1 items]"` instead of real output.
- **Approach**: Serialize faithfully, cap size.
- **Effort**: S
- **Deps**: B3a

### B6 · Enforce the redundant-read guard
- **Problem**: Same file read 11× (60K chars re-pulled) because guard keys on path+range.
- **Approach**: Guard on path only; soft warning + quote prior content.
- **Files**: `src/tools/vault-tools.ts`
- **Effort**: S

### B10 · Per-edit approval within edit batches — DEFERRED
- **Problem**: A 6-edit batch was denied because user disagreed with 1 scope.
- **Assessment**: Only happened once in the audited session. B3b (partial apply on technical failure) already prevents the main pain point. A full per-edit approval UI is high complexity for rare occurrence.
- **Action**: Skip for now. Revisit if batch-denial becomes a frequent pattern.
- **Effort**: M (if ever done)
- **Deps**: B3b

### B12 · Better grounding / intent anchoring
- **Problem**: Flash edited 6 unrelated places for a 1-section request.
- **Approach**: Weight explicit user request higher than attachment context; add synthetic focus hint.
- **Files**: `src/agent/agent-service.ts`, `src/ui/context-builder.ts`, `src/agent/prompts.ts`
- **Effort**: M–L

---

## Group C — Subagent transparency

### C5 · Inline, live, collapsible subagent transcript
- **Problem**: Subagents invisible; no per-child stop.
- **Approach**: Inline collapsible block, simplified plaintext, per-child Stop button.
- **Files**: `src/tools/subagent-tool.ts:87`, `src/agent/subagent-runtime.ts:34`, `src/ui/assistant-bubble.ts:129`
- **Effort**: L
- **Deps**: B4

---

## Group E — Chaining timeline

### E10 · Vertical chaining timeline with per-call check/X
- **Problem**: No visual chaining of tool calls in a run.
- **Approach**: ResizeObserver-driven line per assistant run.
- **Files**: `src/ui/assistant-bubble.ts`, `src/ui/chat-view.ts`, `styles.css`
- **Effort**: L
- **Deps**: D9, D17 (already done)

---

## Group F — Skills + MCP

### F6 · Harness self-knowledge skill
- **Problem**: No skill describing harness capabilities/limits.
- **Approach**: Author auto-present skill covering tools, edit semantics, approval modes, subagent guidance.
- **Effort**: M
- **Deps**: A7, B2/B3

### F8 · Git/FS MCP servers, connect-only, dynamic enable
- **Problem**: Want git + filesystem MCP servers; connect-only (plugin does not spawn).
- **Approach**: Add git/FS config with path; probe on load; disable (not delete) when absent; live status pill.
- **Files**: `src/settings.ts:1056`, `src/mcp/tools.ts:102`
- **Effort**: M

---

## Recommended order

B3a → B3b → B3c → B3d → B2 → B4 → B5 → B6 → B12 → C5 → E10 → F6/F8 → A7.

**B3a is the single highest-leverage fix** — it prevents the edit-match failure loop.
