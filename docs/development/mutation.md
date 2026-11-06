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

The nightly `Nightly` workflow runs the full matrix at 03:00 UTC and on demand.
It uploads `reports/mutation/mutation.json` as an artifact.

## Matrix

The default matrix is the state-machine core:

- `src/agent/loop-guard.ts`
- `src/agent/session-swap-queue.ts`

Add a module only when its test file runs fast and asserts observable behavior.
Keep the matrix small; a wide matrix turns the nightly lane into noise.

## Thresholds

`stryker.config.mjs` uses:

- high: 85
- low: 75
- break: 70

The break threshold fails the run. The first matrix run scored 72.96% overall:
`loop-guard.ts` 73.65% and `session-swap-queue.ts` 68.97%. The swap-queue tests
were added after the first run and raised it from 55.17%. Review the survivors
before raising `break`; many are redundant state writes, not behavior gaps.

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

## Nightly fault lane

The same workflow runs the fault and state-machine tests without mutation. That
lane is the home for slow fault cases: failed writes, delayed reads, `ENOENT`,
aborts at awaits, stale trees, and two-tab races.
