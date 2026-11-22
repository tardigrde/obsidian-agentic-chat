# Trust the change, not the tool

CI cannot prove correctness. It can prove one claim: this test fails without
the change and passes with it. Four layers carry that claim: the **witness**,
the **evidence** (command, counts, artifact) in the PR, an **agent review with
evidence** from a reviewer agent that did not write the change, and a
**regression gate** (the bug class becomes a permanent test or check). A green
CI run, a bot review, or the author agent checking itself is not the review.

## The eight rules

1. Never merge unless the owner writes "merge". Green checks are not permission.
2. Never claim done without the `logs/verify/<ts>/summary.json` path and its
   per-tier counts line.
3. Never go green by skipping. Zero tests or all skipped fails the lane. The
   only allowed skip in T1 and T2 is `it.skip("flaky #<open issue>: ...")`.
4. Never call a model from CI. Live work is local, with a key and a display.
   The one exception is the advisory `OpenCode review` job
   (`.github/workflows/opencode-review.yml`). It posts inline comments and is
   never a gate or a test.
5. Never present scripted as live: every run result states its mode.
6. Never add a retry to a flaky test; fix the observation or the fixture.
7. Never use `no-behavior-change` for a behavior change or a deletion.
8. Every test file belongs to one group in `test/manifest.json`.

## The witness contract

`npm run verify:witness -- --base origin/main --test-file <test> --src <path>`
reverts the `--src` diff, runs the test, restores the diff, and runs it again.
A witness is red then green, and the red is an assertion. The verifier rejects
a red that is a loader, parser, or compiler error; a `TypeError` while the test
file itself changed; a run with no failed-test count (a skip or an empty run).
A `TypeError` counts when the test file is identical at the base: the crash
then comes from the product code. Commit the source first: the tool refuses
dirty source paths. It writes `logs/witness/<ts>/report.md`.

CI reads one block from the PR body and runs it against the PR's base commit,
with the verifier scripts from the base (a PR cannot replace its judge):

```markdown
<!-- witness
test: test/agent-conversation.test.ts
src: src/agent/conversation.ts
-->
```

A `src:` path is under `src/` or `scripts/` and in the diff; it may be a file
the PR deletes. A pure deletion uses a removal witness: each `gone:` path exists
at the base and not at the head; each `absent:` text appears under `src/` at the
base and nowhere under `src/` at the head.

```markdown
<!-- witness
kind: removal
gone: src/ui/plan-mode.ts
absent: agentic-chat:toggle-plan
-->
```

A PR that changes `src/` needs a filled block, or the `no-behavior-change` label
for a pure refactor that the reviewer confirms against the diff. A PR that
changes only tests, docs, or tooling skips the witness run.

## Agent review

After `ci` and `e2e` are green, a reviewer agent posts one verdict comment
(`npm run delegate -- review <pr> <worktree> "<focus>"`, procedure in
`@verify-pr`). The comment format:

```text
Verdict: PASS | PASS+NOTES | FAIL
Head: <sha of the reviewed head>
Reviewer: <agent, not the author>
Witness: <command>, before fix FAIL (assertion), after fix PASS (counts)
Fast lane: PASS (X passed, Y files) | CI (ci + e2e green at this head)
Behavior change: none | yes (<one line>)
Notes: none | <max 5 bullets>
```

The reviewer reads the advisory `OpenCode review` findings for the head and
confirms or rejects each one. The job state is the first line of
`logs/delegate/opencode-<pr>.md`: only `pass` means the finder ran, and any other
state (`failed`, `skipped`, `pending`, `missing`) is not "no findings". A draft
PR is skipped, so mark the PR ready before the review.

A push makes the verdict stale. The `review` check (`Review report` workflow)
only reports whether a verdict exists at the head, an open `FAIL`, and the PR
size; it never fails (#393 D4, D7). Only owner, member, or collaborator comments
count. The owner reads the verdict and its notes, not the whole diff, then
decides the merge.

## Limits

This is a one-account repo. `Reviewer` is a name, so independence is a
convention, not something a check proves: hence "agent review with evidence",
and hence not a required check. A PR can change the workflow that runs a gate;
CODEOWNERS names the gate files, and the owner reads any diff under
`.github/workflows/` and `scripts/` before a merge. Required checks: `ci`, `e2e`,
`witness`.
