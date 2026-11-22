# 0012 — Runs are bounded by Stop, the loop guard, and spend, not a turn cap

- Status: Accepted
- Date: 2026-11-22
- Supersedes: the turn cap and subagent timeout removed in U4 (#409)

## Decision

There is no turn cap and no subagent timeout. A run ends when the model
answers, the user presses Stop, the loop guard fires, or the spend cap is
reached. The pre-send spend check stops new turns; the in-flight check aborts a
turn already underway.

Compaction:

- Triggers at a fill fraction of the context window and compares transcript
  tokens plus request overhead (system prompt, tool schemas, response reserve).
  If folding the transcript cannot reclaim enough, it reports
  `overhead_bound` instead of pretending a summary fixed it.
- Summarises through the same stream function as chat. The summary call gets a
  dedicated system prompt and a reserve for its output.
- Carries the usage of folded turns on the replacement summary message, so cost
  survives JSONL reload and rewind.
- An unknown context window disables auto-compaction rather than guessing 128k.

Delegation:

- N `subagent` calls in one message run concurrently; the subagent tool's slot
  pool caps the fan-out.
- Stateful/interactive tools (ask-user) declare sequential execution, and the
  SDK serializes any batch that contains them.
- A child gets a stop id immediately, so a quiet child can still be stopped.
- `continue` resumes the role of the child it names, not a fresh role.
- Child summaries are capped before they enter the parent context; the full
  transcript stays in the child session.

## Why

A turn cap punishes a legitimate long task and still permits a runaway loop that
does not spend turns. The loop guard catches identical batches; the spend cap
catches a run that keeps producing new, expensive work; Stop is the human
override. Together they bound the cases users actually hit.

Compaction that only counts transcript tokens over-triggers on a large tool
catalog and cannot succeed when the prompt overhead is the problem. Folding
usage into the summary keeps the cost readout honest after a reload.

A timeout on a child is arbitrary: a research subagent may run for minutes while
a tool call is quietly waiting. A stop id gives the user the same control
without guessing a duration.

## Consequences

- No `maxTurns` or subagent timeout setting exists; do not add one without a new
  ADR.
- `src/agent/loop-guard.ts`, `src/agent/compaction.ts`, and
  `src/agent/compaction-runtime.ts` own the bounds.
- `src/tools/subagent-tool.ts` owns fan-out and continuation; the child runtime
  owns stop state.
- Tests pin the past-the-old-cap behavior in `test/ui/no-turn-cap.test.ts`.

## Links

- `src/agent/parent-agent-configuration.ts`
- `src/agent/loop-guard.ts`
- `src/agent/compaction.ts`
- `src/agent/compaction-runtime.ts`
- `src/tools/subagent-tool.ts`
- `test/ui/no-turn-cap.test.ts`
