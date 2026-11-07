# 0004 — Do not merge memory v2

- Status: Accepted
- Date: 2026-11-07
- Issue: #143, #145

## Decision

Do not merge the memory v2 branch or the recall-compacted-turns branch. Keep the
current memory behavior. Use `AGENTS.md` as the durable cross-session memory for
now.

## Why

- The memory v2 PR is 52 files and about 3,600 lines. It adds daily notes, a
  distilled `MEMORY.md`, scheduler behavior, and another tool.
- The current memory is not injected into the prompt; the agent must call
  `search_memory`. That is not enough value to justify a large subsystem now.
- The product is being cut. A new memory subsystem is the wrong direction until
  the core is smaller.

## Consequences

- Close #143 and #145 with links to this ADR.
- Archive the memory design if it may return.
- Revisit memory only after the interaction cut, and only as a small v1.
- `AGENTS.md` stays the durable memory for repository work.

## Links

- #143 (the design is preserved in the closed PR history)
- #145
