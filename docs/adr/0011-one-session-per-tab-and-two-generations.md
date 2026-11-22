# 0011 — One session per tab, guarded by two generations

- Status: Accepted
- Date: 2026-11-22

## Decision

A session file belongs to at most one tab. Opening a session that is already
open switches to that tab; it does not load a second live agent for the same
file. Each tab has a stable key so a rename follows the tab, not its index.

Every transcript discontinuity advances a generation token. There are two:

- `sessionGeneration` guards writes and sends after any session change.
- `conversationGeneration` advances only on a swap or rewind, so a compaction
  that started before the switch cannot commit its transcript afterward.

A captured transcript is always paired with the generation it was read from.
Writes, sends, and compaction commits compare both. A mismatch aborts the
commit, not the whole session.

All live-session mutations (pointer move, transcript rewrite, live-agent
replacement) run as single steps of one queue. A failed swap is reported to the
queue and retried; it never leaves the agent pointing at a half-loaded file.

Tab labels are separate from session names. A label is trimmed and capped; an
empty label means no label. A rewind starts a new conversation token and binds
the continuation to it.

## Why

Two tabs on one file create two writers, two JSONL appends, and two live agents
whose costs and tool approvals disagree. Switching to the existing tab is the
only state with one owner.

A single generation is not enough: after a swap, an in-flight compaction must
not land on the new session, but a new prompt in the same session should not
invalidate an unrelated transcript rewrite. Separating the two lifetimes makes
both failures impossible.

The queue exists because a rapid UI trigger can interleave detach, create, load,
and replace work. Loading is asynchronous; without serialization the agent can
observe a mix of old and new state.

## Consequences

- `src/session/session-manager.ts` owns the generations and atomic rewrite
  (temp file, backup, generation check).
- `src/agent/session-actions.ts` owns the queue; new mutations join it.
- `src/ui/chat-tabs.ts` owns parked drafts and stable tab keys.
- A corrupt JSONL line is skipped and logged rather than losing the session.
  The parent chain still rebuilds the resumable transcript.
- `src/ui/session-swap-queue.ts` serializes UI-triggered swaps.

## Links

- `src/session/session-manager.ts`
- `src/session/jsonl.ts`
- `src/agent/session-actions.ts`
- `src/agent/session-swap-queue.ts`
- `src/ui/chat-tabs.ts`
- `test/session-invariants.test.ts`
- `test/session-multi-instance.test.ts`
