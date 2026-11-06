---
name: Verify PR
description: Use when you must give an independent verdict on a pull request you did not write. Reproduces the red/green witness, runs the merge lane, checks for new global state, and reports PASS, PASS+NOTES, or FAIL. Do not use it to review your own change, and do not merge.
---

# Verify PR

An independent verdict is a claim about a run, not an opinion about a diff. You
did not write the code; your job is to prove the author's witness or reject it.

## Inputs

- PR number or branch.
- The witness block from the PR body.
- The source paths the fix changed.

If the PR body does not name a witness for a source change, stop and return
`FAIL` with `missing witness`. The only exception is the `no-behavior-change`
label: confirm against the diff that the change is a pure refactor, then verify
the existing tests still pass. A behavior change with that label is `FAIL`.

## Protocol

1. Work in a clean checkout or worktree of the PR head. Never verify in the
   author's dirty tree. Record `git rev-parse HEAD`.
2. Run the witness on the head. It must pass, with counts.
3. Prove the witness is real:

   ```bash
   npm run verify:witness -- \
     --base origin/main \
     --test-file <test> \
     --src <source-path> [--src <source-path>]
   ```

   It reverts the source diff, runs the test (must fail on an assertion),
   restores the diff, and runs the test again (must pass). The command prints
   `verify-witness: PASS` and writes `logs/witness/<timestamp>/report.md`.

4. Run the merge lane:

   ```bash
   npm run verify -- fast
   ```

   Read the counts. Zero tests, or every test skipped, is a failure.

5. Check for new module-level mutable state in the diff:

   ```bash
   git diff origin/main...HEAD -- '*.ts' | rg '^(\+.*)(new Map|new Set|= \[\]|= \{\})'
   ```

   A new global registry needs a comment that names its owner and a test that
   proves isolation. Without both, return `PASS+NOTES` at best.

6. Judge the test, not only the result. It must assert behavior a caller can
   observe. Reject a test that mirrors the implementation, mocks the subject, or
   would pass with the source change reverted.

7. Check that the PR body evidence matches the runs: the command, the counts,
   and the report path. Stale evidence is a `FAIL`.

8. Check the `no-behavior-change` claim against the diff. A new branch, a changed
   output, or a changed error path is behavior. Return `FAIL`.

9. Report the verdict. Do not merge.

## Verdicts

- `PASS`: witness red then green, `fast` green with counts, no unresolved blocker.
- `PASS+NOTES`: proven, but a non-blocking risk needs the human's attention.
- `FAIL`: the witness passes without the fix, the red run never reached an
  assertion, `fast` fails, the test is not a witness, or a new global state has
  no isolation proof.

## Output

```text
Verdict: PASS | PASS+NOTES | FAIL
Head: <sha>
Witness: <command>
  before fix: FAIL (assertion, counts)
  after fix:  PASS (counts)
Witness proof: logs/witness/<timestamp>/report.md
Fast lane: PASS (X passed, Y files)
New global state: none | <file:line + isolation test>
Notes: none | <max 5 bullets>
```

Do not apply fixes. Report the failure and the command that proves it. The author
owns the change. The repository owner alone decides to merge.

## Stop conditions

- The witness passes with the fix reverted. Stop; it is not a witness.
- The red run fails in the loader, a skip, or a timeout. Stop; no assertion ran.
- The source diff is empty. Stop; there is nothing to verify.
- `fast` fails for a reason the PR claims to fix. Stop; report the failure.
- The PR changes product behavior or data format without an explicit decision in
  the body. Return `FAIL`; that decision is the human's call.
- The PR is over roughly 400 changed lines or 10 files. Return `PASS+NOTES` and
  ask for a split unless the change is one mechanical unit.
