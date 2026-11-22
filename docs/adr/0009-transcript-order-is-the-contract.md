# 0009 — Transcript order is the contract, not the DOM

- Status: Accepted
- Date: 2026-11-22

## Decision

The transcript is an ordered event log: thinking, answer text, tool steps, approval record, subagent
rows. Tests assert that order by content tokens, never by sibling position or CSS class. Moving nodes is
allowed; reordering content is a regression.

Replay builds the same segments and rows as the live path, with deltas buffered per animation frame and
the first answer text settling the reasoning row.

## Why

Pinning DOM siblings makes every styling refactor a test rewrite and still misses the bug users see:
content in the wrong order. A late delta or a tool call can move the turn to a new segment, so appending
to the old target duplicates text or puts the thinking row below the answer.

## Consequences

- Keep the shared order readers content-based: `test/ui/support/transcript-order.ts`.
- A new event type defines its place in the order and how replay renders it; a DOM branch alone is not enough.
- `src/ui/assistant-bubble.ts` owns the frame buffer; `src/ui/transcript-view.ts` owns segment boundaries.
- Never intercept Ctrl/Cmd+W outside the composer. Mermaid SVG never goes through `innerHTML`.

## Links

- `src/ui/assistant-bubble.ts`
- `src/ui/transcript-view.ts`
- `test/ui/transcript-order.test.ts`
- ADR 0008 (the approval card is part of the turn)
