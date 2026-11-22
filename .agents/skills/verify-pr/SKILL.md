---
name: Verify PR
description: Use when you must give an agent-review verdict on a pull request you did not write. Reproduces the red/green witness, checks the merge lane, checks for new global state, and reports PASS, PASS+NOTES, or FAIL. Do not use it to review your own change, and do not merge.
---

# Verify PR

A verdict is a claim about a run, not an opinion about a diff. You did not write
the code; prove the author's witness or reject it. Rules and lanes:
[testing.md](../../../docs/development/testing.md); the witness contract and the
comment format: [trust.md](../../../docs/development/trust.md).

```bash
npm run verify:witness -- --base origin/main --test-file <test> --src <path> [--src <path>]
gh pr checks <pr>              # ci and e2e green at the head? cite them
npm run verify -- check --no-app   # only when CI did not run at this head
```

## What a reviewer runs

Run only `check --no-app` (lint, typecheck, unit tests, build), `npx vitest`,
and the witness on a unit test. Do not run
anything that starts Obsidian or calls a model: no `verify -- app`, e2e, dogfood,
`eval`, `explore`, or `check` without `--no-app`. The `e2e` CI job is the proof
for the real-app tier. When the witness is an e2e spec, cite the author's red and
green runs from the PR body and the `e2e` job at this head; do not re-run it.

The `OpenCode review` job posts advisory inline comments on each PR. Read them
(the first line of `logs/delegate/opencode-<pr>.md` is the job state: only `pass`
means the finder ran; any other state is not "no findings", so say so) and
confirm or reject each one in your notes; they are not a verdict. Its prompt,
[.github/opencode-review-prompt.md](../../../.github/opencode-review-prompt.md),
lists the bug classes for this repo; check the diff against that list too.

## Inputs

The PR number, the witness block in its body, and the source paths it changed.
A source change with no witness is `FAIL: missing witness`. The only exception
is the `no-behavior-change` label: confirm against the diff that it is a pure
refactor; a behavior change with that label is `FAIL`.

## Protocol

1. Work in a clean worktree at the PR head. Record `git rev-parse HEAD`.
2. Run the witness at the head: it passes, with counts.
3. Prove it is real with `verify:witness`: the source diff reverted, the test
   fails on an assertion; restored, it passes. It writes
   `logs/witness/<ts>/report.md`.
4. Cite CI (`ci` and `e2e` green at this head), or run `check --no-app` and
   read the counts. Zero tests or all skipped is a failure.
5. Look for new module-level mutable state:
   `git diff origin/main...HEAD -- '*.ts' | rg '^(\+.*)(new Map|new Set|= \[\]|= \{\})'`.
   A new global registry needs an owner comment and an isolation test, or the
   verdict is `PASS+NOTES` at best.
6. Judge the test: it asserts behavior a caller can see. Reject a test that
   mirrors the implementation, mocks the subject, or passes with the fix
   reverted.
7. Check that the PR body evidence (command, counts, report path) matches the
   runs. Stale evidence is `FAIL`.
8. Ask the bug-class questions; each "yes" needs a test or a note:
   - Per-instance state that another tab or window shares? Model two instances
     over one adapter.
   - A persisted shape (`data.json`, session JSONL)? The upgrade fixtures must
     pass; a removed key needs a user notice.
   - A second estimator of an existing number (context fill, cost, turn count)?
     Test that the two agree.
   - Work queued for the runtime (steer, follow-up)? Assert the queue is empty
     at `agent_end`.
   - A prompt or tool change? The canary table must be in the PR.
9. Report the verdict. Do not merge and do not fix.

## Verdicts

- `PASS`: witness red then green, CI or `check` green with counts, no blocker.
- `PASS+NOTES`: proven, but a non-blocking risk needs the owner's attention.
- `FAIL`: the witness passes without the fix, the red run never reached an
  assertion, the merge lane fails, the test is not a witness, or new global
  state has no isolation proof.

## Output

```text
Verdict: PASS | PASS+NOTES | FAIL
Head: <full or 7+ char sha>
Reviewer: <agent, not the author>
Witness: <command>
  before fix: FAIL (assertion, counts)
  after fix:  PASS (counts)
Witness proof: logs/witness/<ts>/report.md
Fast lane: PASS (X passed, Y files) | CI (ci + e2e green at this head)
Behavior change: none | yes (<one line>)
New global state: none | <file:line + isolation test>
Notes: none | <max 5 bullets>
```

Post it as one PR comment after `ci` and `e2e` are green. It is advisory: the
owner reads it before "merge". `Behavior change: none` lets the delegate script
set the `no-behavior-change` label; write it only for a pure refactor you
checked. A push makes the verdict stale.

## Stop conditions

- The witness passes with the fix reverted: not a witness.
- The red run fails in the loader, a skip, or a timeout: no assertion ran.
- The source diff is empty: nothing to verify.
- The PR changes product behavior or a data format without an explicit
  decision in the body: `FAIL`; that decision is the owner's.
- More than about 400 lines or 10 files under `src/` (tests, docs, and
  deletions do not count): `PASS+NOTES` and ask for a split, unless it is one
  mechanical unit.
