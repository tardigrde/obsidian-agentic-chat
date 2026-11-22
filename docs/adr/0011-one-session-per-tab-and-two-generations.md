# 0011 — One session per tab, guarded by two generations

- Status: Accepted
- Date: 2026-11-22

## Decision

A session file belongs to at most one tab. Opening a session that is already open switches to that tab;
it never starts a second live agent on the same file. Each tab has a stable key, so a rename follows the
tab, not its index.

`sessionGeneration` covers writes and sends after any session change; `conversationGeneration` advances
only on a swap or rewind. A captured transcript is paired with its generation, and a mismatch aborts that
commit. Mutations run as steps of one queue, and a failed swap is retried, never left half-loaded.

## Why

Two tabs on one file give two writers, two JSONL appends, and two agents whose costs and approvals
disagree. One token conflates lifetimes: a compaction from before a swap must not land on the new
session, while a new prompt must not block an unrelated rewrite. The queue serializes async loading.

## Consequences

- `src/session/session-manager.ts` owns the generations and atomic rewrite; `src/agent/session-actions.ts` owns the queue.
- A corrupt JSONL line is skipped and logged; the parent chain still rebuilds the transcript.
- Keep tab labels separate from names, and bind a rewind continuation to a new token.

## Links

- `src/session/session-manager.ts`
- `src/agent/session-actions.ts`
- `test/session-invariants.test.ts`
