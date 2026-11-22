# 0012 — Runs are bounded by Stop, the loop guard, and spend, not a turn cap

- Status: Accepted
- Date: 2026-11-22
- Supersedes: the turn cap and subagent timeout removed in U4 (#409)

## Decision

There is no turn cap and no subagent timeout. A run ends when the model answers, the user presses Stop,
the loop guard fires, or the spend cap is reached; the pre-send check stops new turns and the in-flight
check aborts a running one.

Compaction triggers on a fill fraction of the context window, counting tokens plus overhead. It reports
`overhead_bound` when folding cannot reclaim enough, and an unknown window disables auto-compaction
instead of guessing 128k. A child gets a stop id at once, so a quiet child is stoppable.

## Why

A turn cap punishes a long legitimate task and still permits a loop that spends no turns; the guard
catches identical batches, spend catches new expensive work, and Stop is the override. A child timeout is
arbitrary. Counting only transcript tokens over-triggers on a large tool catalog.

## Consequences

- Do not add `maxTurns` or a subagent timeout without a new ADR.
- `src/agent/loop-guard.ts` and `src/agent/compaction.ts` own the bounds; no window means no compaction.
- Folded usage rides the summary message, so cost survives reload and rewind.

## Links

- `src/agent/loop-guard.ts`
- `src/agent/compaction.ts`
- `test/ui/no-turn-cap.test.ts`
