# Mutation testing

A green test suite proves that the tests pass. Mutation testing proves that the
tests can fail. Stryker changes the source one small step at a time and runs the
same suite. A mutant that survives is either a missing assertion or an equivalent
change that no test can observe.

## Run it

```bash
npm run mutation
```

Narrow the matrix locally:

```bash
STRYKER_MUTATE=src/agent/session-swap-queue.ts npm run mutation
```

Run it weekly on your machine. It is not a CI job and not a gate.

## Matrix

The default matrix is the five UI hot spots: the files with the most fix
commits (#393 T18).

- `src/ui/chat-view.ts`
- `src/ui/approval-card.ts`
- `src/main.ts`
- `src/ui/assistant-bubble.ts`
- `src/ui/session-list-modal.ts`

The list is `HOT_SPOTS` in `stryker.config.mjs`. Add a module only when its test
file runs fast and asserts observable behavior.

## Score

`stryker.config.mjs` has no break threshold. The run prints a score per file and
never fails on it. The colors use high 80 and low 60.

First run (2026-11-17, concurrency 4, 2,015 mutants, about 20 min):

| File | Score | Mutants |
|---|---|---|
| `src/ui/session-list-modal.ts` | 61.9% | 155 |
| `src/ui/approval-modal.ts` | 61.6% | 485 |
| `src/ui/chat-view.ts` | 41.1% | 591 |
| `src/ui/assistant-bubble.ts` | 33.1% | 531 |
| `src/main.ts` | 11.1% | 253 |
| total | 41.8% | 2,015 |

`src/main.ts` is mostly Obsidian wiring that only e2e reaches, so a low score is
expected there. Use the survivors in `chat-view.ts` and `assistant-bubble.ts` to
pick the next `test/ui/` tests. The run is over the 15 min target; narrow it with
`STRYKER_MUTATE` when you work on one file.

## Reading a survivor

1. Read the mutation. If the changed line cannot affect an observable result, it
   is equivalent. Say so in the PR or the mutation note.
2. If the line can change behavior, write the smallest test that fails without
   it. Add the test to the module's normal suite, not to the mutator.
3. If the test would be slow or flaky, keep the survivor and record why in the
   escaped-defect log or the PR.

Do not chase 100%. A mutation score is a signal about test strength, not a
release goal.

## Escaped defects

Use [escaped-defects.md](escaped-defects.md) when a defect reaches a release.
Record the missing test and the mutation that would have caught it, then add the
regression test.

## Fault tests

Run the focused fault and state-machine set on demand:

```bash
npm test -- test/session-swap-queue.test.ts test/session-manager.test.ts \
  test/session-invariants.test.ts test/session-actions.test.ts \
  test/agent-service.test.ts
```

That lane is the home for slow fault cases: failed writes, delayed reads,
`ENOENT`, aborts at awaits, stale trees, and two-tab races.
