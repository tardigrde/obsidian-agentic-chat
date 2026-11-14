# Trust the change, not the tool

CI cannot prove correctness. It can prove one specific claim.

This repo uses four layers for that claim:

1. **Witness.** The smallest check that fails before the change and passes after.
2. **Evidence.** The command, its counts, and the artifact, in the PR body.
3. **Independent verdict.** A verifier that did not write the change reproduces
   the witness and runs the merge lane.
4. **Regression gate.** The bug class becomes a permanent test, lint rule, or CI
   check.

A green CI run is not layer 3. A bot review is not layer 3. The author checking
their own work is not layer 3.

## The witness tool

`scripts/verify-witness.mjs` proves a test is a witness. It takes the source diff
against a base ref, applies it in reverse, runs the test, restores the diff, and
runs the test again.

```bash
npm run verify:witness -- \
  --base origin/main \
  --test-file test/agent-conversation.test.ts \
  --src src/agent/conversation.ts
```

A real witness prints `verify-witness: PASS` and is red then green. A test that
passes without the fix prints `verify-witness: FAIL`.

A non-zero red is not enough. The verifier rejects a red run that:

- matches a loader, parser, or compiler error (`SyntaxError`,
  `Cannot find module`, `error TS####`);
- reports no failed-test count, which covers skips and empty runs;
- reports zero failed tests.

The command writes:

```text
logs/witness/<timestamp>/
  witness.patch
  summary.json
  report.md
```

`logs/` is gitignored. Attach the report path to the PR; do not commit it.

Self-test the verifier:

```bash
npm run verify:witness -- --self-test
```

It builds a temporary git repository, proves a real witness red then green, and
rejects a test that passes without the fix, a loader failure, and a red without
a failed-test count.

Rules:

- Commit the source change first. The tool refuses dirty source paths.
- Revert only `--src` paths. Test files stay at the PR head.
- The witness command must not write to the source paths.

## The CI gate

The `Witness` workflow runs on every pull request, including forks with a
read-only token.

1. It always runs `npm run verify:witness -- --self-test`.
2. It reads a witness block from the PR body.
3. It runs the declared witness against the pull request base commit.

The workflow accepts a test file and source paths, never a shell command. CI
supplies the base, so a PR cannot choose its own comparison point.

```markdown
<!-- witness
test: test/agent-conversation.test.ts
src: src/agent/conversation.ts
-->
```

A PR that changes a file under `src/` must have a non-empty block. A pure
refactor can use the `no-behavior-change` label instead, and the independent
verifier must confirm that claim against the diff. The empty block in the PR
template does not count. A PR that changes only tests, docs, or tooling skips the
witness run.

Add a second `src:` line for each changed source path. If the body has more than
one filled block, the run fails; keep one block.

Fork PRs run the same job. They get a read-only token, so the witness cannot read
secrets or write to the repository.

The job checks out the PR head into `pr/` and the pull request base commit into
`trusted/`. It runs `trusted/scripts/verify-witness.mjs` and
`trusted/scripts/witness-from-pr.mjs` with `pr/` as the working directory, so the
declared test and source files come from the PR, but the scripts that decide red
and green come from the base. A PR cannot replace the verifier that judges it.
The test command itself (`npm run verify -- change <test>`) still runs the PR's
`package.json` and test config; the independent verifier checks those.

## Independent verdict

The verifier is a separate agent, ideally on a different model family. Load
`@verify-pr`. The verifier must not be the author.

The verifier:

1. checks out the PR head in a clean worktree;
2. runs the witness and confirms the counts;
3. runs `npm run verify:witness` and reads the report;
4. runs `npm run verify -- fast`;
5. checks for new module-level mutable state;
6. posts a PR comment with `PASS`, `PASS+NOTES`, or `FAIL` and the full output
   template, including `Head`, `Reviewer`, and `Fast lane`.

The human reads the verdict and the `Attention` list, not the whole diff. A
verdict is evidence, not permission. The merge rule still applies: do not merge
without an explicit "merge" from the repository owner.

## The review gate

The `Review gate` workflow runs on pull request updates and on new or edited PR
comments. It reads the verdict comments at the current head and fails when:

- no trusted comment has all four fields: `Verdict`, `Head`, `Reviewer`, and a
  `Fast lane` with a test count (`Fast lane: PASS (1702 passed, 173 files)`;
  `Fast lane: PASS` alone does not count);
- a `FAIL` at this head is not cleared (see below);
- the `Head` value does not match the checked-out PR head;
- the `Fast lane` cites CI (`Fast lane: CI ...`) but the `ci` and `e2e` checks
  have not both passed at the head;
- the PR adds more than 1000 lines under `src/`, or adds lines to more than 25
  files under `src/`, unless it has the `large-pr` label.

Only comments from `OWNER`, `MEMBER`, or `COLLABORATOR` accounts count. Bots and
`CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` accounts are ignored.

A `FAIL` is sticky. Verdicts are ordered by creation time, so editing an old
comment does not move it. A `FAIL` at the current head is cleared only by a later
`PASS` or `PASS+NOTES` at the same head whose `Reviewer` differs from the
`FAIL`'s. The author agent cannot overturn an independent `FAIL` by posting its
own `PASS` under the same name; push a fix, which moves the head, or get a second
independent reviewer.

The gate script runs from the trusted base: the PR head is checked out into
`pr/` (measured for size and head SHA), the base into `trusted/`, and the job runs
`node ../trusted/scripts/check-review-gate.mjs` from `pr/`. On a comment event
the base is the default branch. The workflow file itself still comes from the
PR on `pull_request` events, so a PR that edits `.github/workflows/` needs a
human read of that diff.

A run triggered by a comment (`issue_comment`) attaches to the default branch,
not to the PR head, so it does not update the PR's `review` check. The workflow
stays read-only. After posting a verdict comment, re-trigger the PR check, for
example by editing the PR body. The script prints this hint on comment runs.

The size budget measures risky code only (#288). It counts lines **added**
under `src/`. Deleted lines, tests, docs, skills, scripts, lockfiles, and other
generated files are free, so a removal or a docs sweep fits without an
override. Renames are judged by the destination path and count only their added
lines, so a pure move into `src/` is free. The gate reads
`git diff --numstat -z`, so no path is quoted or split on `=>`. Moving or
deleting code out of `src/` is also free; the reviewer reads such a diff, the
budget does not. Split a large change; use `large-pr` only for one
mechanical unit.

This repository has one GitHub account, so the workflow sets
`REVIEW_GATE_SINGLE_ACCOUNT=1`. The gate cannot compare two logins. Independence
comes from a separate reviewer agent, recorded in `Reviewer`. When a reviewer
account exists, set the flag to `0` and the gate also rejects the author's own
comment.

The committed findings ledger is [review-ledger.md](review-ledger.md). Add a row
for every blocking finding and for every deferred one.

After the workflow is on `main`, add `review` to the required checks in the
ruleset.

## Review tiers

| Tier | Examples | Review policy |
|---|---|---|
| A | test-only, docs, mechanical ownership with an isolation test | CI and an independent `PASS` |
| B | protocol state, persisted state, single-flight guards | human reads the witness and the changed public behavior |
| C | session lifecycle, UI behavior, data format | human reads the design, the failure tests, and the e2e/probe evidence |

If a PR cannot be explained in five lines, split it. Prefer five narrow PRs to one
large PR.

## Merge safety

These are repository settings, not files:

- protect `main`;
- require `ci` and `e2e`;
- require the branch to be up to date before merge;
- require a PR and forbid force pushes and deletions;
- delete the branch after merge.

The required independent check is not a GitHub setting yet. Until it is, the
reviewer posts the verdict and the owner reads it before merge. The owner applies
the explicit-merge rule.

## AFK run protocol

Use this when the human steps away and wants verified PRs prepared one by one.

Exit predicate:

> All planned PRs are ready to merge. Each PR has a witness that failed before
> and passed after, an independent `PASS`, and `verify -- fast` green at its
> head. `main` is green after each merge.

Loop for each invariant, bottom-up:

1. Rebase onto `main`.
2. Run the witness on the base commit; keep the red output.
3. Apply the smallest fix.
4. Run the witness; keep the green output.
5. Run `npm run verify:witness` and `npm run verify -- fast`.
6. Open the PR with the template.
7. Spawn the independent verifier in a clean worktree.
8. Stop at `PASS`; wait for the owner's explicit "merge".
9. Rebase the next PR and repeat.

Stop and report when:

- the same CI failure appears twice for the same reason;
- the verifier returns `FAIL`;
- the fix needs a product or preference decision;
- an irreversible action is required;
- `main` is red;
- the witness cannot be made deterministic.

## What this does not cover yet

- **Feature-map gate.** The proof tables still need a checker that validates
  every `path:line` reference and rejects `covered` without a user-action check.
- **Mutation testing.** A surviving mutant on changed lines is the strongest
  proof that a test can fail.
- **State-space checks.** Session swap and compaction need a state × event
  matrix test.
- **Nightly drift.** The `Nightly` workflow runs the full e2e suite, the mobile
  lane, a dry chaos run, and the mutation matrix. Dogfood, eval, and audit lanes
  still run on demand.

## Accepted limits of the review gate

Decided for this experimental, one-account repo. Revisit if a second maintainer
or a reviewer account appears.

- **Free-text reviewer.** `Reviewer` is a name the owner types, so the owner can
  clear a `FAIL` by naming someone else. Independence is a convention here, not
  something the gate can prove.
- **Workflow self-edit.** A PR can change the workflow that runs the gate. Read
  any diff under `.github/workflows/` and `scripts/` by hand before merging.
- **Re-trigger after a verdict.** A verdict comment does not update the PR's
  `review` check by itself. `npm run delegate -- review|recheck|update` re-runs
  the newest `pull_request` Review gate run after posting; by hand, re-run that
  run (`gh run rerun <id>`).

## Sources

The process borrows from pstack:

- `tdd` and `sequence-verifiable-units` for the red/green unit.
- `prove-it-works` for the real run, not the summary.
- `shipping` for the independent verifier and bottom-up merge.
- `babysit` for one retry, then classify.
- `show-me-your-work` for the decision log.
- `interrogate` and `blast-radius` for run-proven findings.
- `never-block-on-the-human` for reversible work.
