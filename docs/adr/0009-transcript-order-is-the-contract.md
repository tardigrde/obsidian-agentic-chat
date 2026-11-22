# 0009 — Transcript order is the contract, not the DOM

- Status: Accepted
- Date: 2026-11-22

## Decision

The rendered transcript is an ordered event log. Tests assert the reader's
order (thinking, answer text, tool steps, approval record, subagent rows) by
content tokens, never by sibling position or CSS class. A rendering change that
keeps the order may move nodes; a change that reorders content is a regression.

Streaming follows these rules:

- Text and reasoning deltas are buffered and flushed once per animation frame,
  so a fast token stream causes one DOM mutation per frame, not one per token.
- A late delta after the final render must not append raw text over rendered
  markdown. The buffer counts as content when deciding whether a turn is empty.
- The first answer text settles the reasoning row. A tool call settles the text
  before it; a step after text opens a new segment below that text.
- Replay builds the same segments and rows as the live path. Source chips and
  persisted image thumbnails are part of the turn, not decorations.
- Retry replaces a failed turn: drop the trailing failed assistant reply and
  continue from the kept user turn and tool results. It never repeats the user
  message or duplicates the tool batch.
- Enter sends; Shift+Enter inserts a newline. Ctrl/Cmd+W is previous-word delete
  only while the composer is focused. Everywhere else it keeps Obsidian's
  close-tab binding, and on macOS it is never intercepted.
- Mermaid SVG is parsed in an inert document, validated for an `<svg>` root, and
  imported as a node. It never goes through `innerHTML`.

## Why

A transcript is read, not inspected. Pinning DOM siblings makes every styling
refactor a test rewrite and still misses the bug users see: content in the wrong
order. Reader-order tokens survive markup changes and catch the real failure.

The streaming rules exist because deltas can arrive after a render, after an
error, or after a tool call has already moved the turn to a new segment.
Appending to the old target produces duplicated text or a thinking row below the
answer. The buffer and segment boundaries are the invariant that keeps live and
replayed turns identical.

## Consequences

- `test/ui/support/transcript-order.ts` and `test/e2e/support/transcript-order.ts`
  are the shared order readers.
- A new event type must define where it sits in the order and how replay renders
  it; adding a DOM branch alone is incomplete.
- `assistant-bubble.ts` owns the frame buffer, and `transcript-view.ts` owns
  segment boundaries. Do not move either rule into CSS.
- The approval card is part of the turn order; see ADR 0008.

## Links

- `src/ui/assistant-bubble.ts`
- `src/ui/transcript-view.ts`
- `src/ui/activity-line.ts`
- `src/ui/chat-turn.ts`
- `test/ui/transcript-order.test.ts`
- `test/e2e/specs/timeline-u4.e2e.ts`
