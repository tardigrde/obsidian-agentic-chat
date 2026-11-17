# Trust the change, not the tool

CI cannot prove correctness. It can prove one specific claim.

This repo uses four layers for that claim:

1. **Witness.** The smallest check that fails before the change and passes after.
2. **Evidence.** The command, its counts, and the artifact, in the PR body.
3. **Agent review with evidence.** A reviewer agent that did not write the
   change reproduces the witness and cites the merge lane. Same GitHub account,
   so this is a separate agent, not an independent human.
4. **Regression gate.** The bug class becomes a permanent test, lint rule, or CI
   check.

A green CI run is not layer 3. A bot review is not layer 3. The author agent
checking its own work is not layer 3.

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
  `Cannot find module`, `error TS####`, a bundled import that resolved to
  nothing such as `(0, import_x.y) is not a function`);
- matches `TypeError` or `is not a function` while the test file differs from
  the base (a new or edited test calling something the reverted tree lacks);
- reports no failed-test count, which covers skips and empty runs;
- reports zero failed tests.

A `TypeError` red counts when the test file is byte-identical at the base and
the head: the crash then comes from the product code the fix repairs.

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
a failed-test count. It also accepts a product `TypeError` red with an unchanged
test, and restores a deleted source file on the red side.

Rules:

- Commit the source change first. The tool refuses dirty source paths.
- Revert only `--src` paths. Test files stay at the PR head. A `--src` path may
  be a file the PR deletes: reverting the diff restores it.
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

A `src:` line may name a file under `src/` or `scripts/`, including a file the
PR deletes or moves away (it must be in the diff). Paths outside those two
directories, absolute paths, and `..` are rejected.

A pure deletion proves the entry point is gone with a removal witness instead
of a test:

```markdown
<!-- witness
kind: removal
gone: src/ui/plan-mode.ts
absent: agentic-chat:toggle-plan
-->
```

Each `gone:` path must exist at the base and be absent at the head; each
`absent:` text (a command id, a setting key, a CSS class) must appear under
`src/` at the base and nowhere under `src/` at the head.

A PR that changes a file under `src/` must have a non-empty block. A pure
refactor can use the `no-behavior-change` label instead, and the reviewer agent
must confirm that claim against the diff; a deletion is not a refactor. The
empty block in the PR template does not count. A PR that changes only tests,
docs, or tooling skips the witness run.

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
`package.json` and test config; the reviewer agent checks those.

## Agent review

The reviewer is a separate agent, ideally on a different model family. Load
`@verify-pr`. The reviewer must not be the author agent. Review starts after the
`ci` and `e2e` checks are green at the head, and posts one verdict per PR.

The verifier:

1. checks out the PR head in a clean worktree;
2. runs the witness and confirms the counts;
3. runs `npm run verify:witness` and reads the report;
4. runs `npm run verify -- check`;
5. checks for new module-level mutable state;
6. posts a PR comment with `PASS`, `PASS+NOTES`, or `FAIL` and the full output
   template, including `Head`, `Reviewer`, and `Fast lane` (the field name is
   historical; cite `CI` or a `check` count).

The human reads the verdict and the `Attention` list, not the whole diff. A
verdict is evidence, not permission. The merge rule still applies: do not merge
without an explicit "merge" from the repository owner.

## The review report

The `Review report` workflow (`review` check) runs on pull request updates. It
is advisory (#393 D4, D7): it never fails. It prints, and writes to the job
summary:

- whether a trusted verdict comment exists at the current head (`Verdict`,
  `Head`, `Reviewer`, and `Fast lane` with a test count or `CI`), and whether a
  `FAIL` there is still open;
- the PR size: lines added and files touched under `src/`, with a note when the
  PR is over 1000 lines or 25 files. Size never blocks; the review tiers below
  ask for a split.

Comments no longer trigger it: a comment run attached to the default branch and
could not update the PR check. The script runs from the trusted base with
`continue-on-error`, so a base that still enforces cannot turn it red.

Only comments from `OWNER`, `MEMBER`, or `COLLABORATOR` accounts count. A `FAIL`
is sticky: a later `PASS` at the same head from a different `Reviewer` clears it.
This repository has one GitHub account (`REVIEW_GATE_SINGLE_ACCOUNT=1`), so the
report cannot compare two logins.

The committed findings ledger is [review-ledger.md](review-ledger.md). Add a row
for every blocking finding and for every deferred one.

Owner settings that go with this: remove `review` from the required checks;
keep `ci`, `e2e`, and `witness` required; consider adding `dogfood-scripted`;
turn on "Require review from Code Owners" so `.github/CODEOWNERS` protects the
gate files.

## Review tiers

| Tier | Examples | Review policy |
|---|---|---|
| A | test-only, docs, mechanical ownership with an isolation test | CI and an agent-review `PASS` |
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

Agent review is not a required check (D4). The reviewer posts the verdict and
the owner reads it before merge. The owner applies the explicit-merge rule.

## AFK run protocol

Use this when the human steps away and wants verified PRs prepared one by one.

Exit predicate:

> All planned PRs are ready to merge. Each PR has a witness that failed before
> and passed after, an agent-review `PASS`, and `verify -- check` green at its
> head. `main` is green after each merge.

Loop for each invariant, bottom-up:

1. Rebase onto `main`.
2. Run the witness on the base commit; keep the red output.
3. Apply the smallest fix.
4. Run the witness; keep the green output.
5. Run `npm run verify:witness` and `npm run verify -- check`.
6. Open the PR with the template.
7. Spawn the reviewer agent in a clean worktree once CI is green.
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
- **Nightly drift.** Dogfood, eval, audit, and mobile lanes still run on demand.

## Accepted limits of agent review

Decided for this experimental, one-account repo. Revisit if a second maintainer
or a reviewer account appears.

- **Free-text reviewer.** `Reviewer` is a name the owner types. Independence is
  a convention here, not something a check can prove; hence "agent review with
  evidence", and hence it is not a required check.
- **Workflow self-edit.** A PR can change the workflow that runs a gate.
  CODEOWNERS names the gate files; read any diff under `.github/workflows/` and
  `scripts/` by hand before merging.

## Sources

The process borrows from pstack:

- `tdd` and `sequence-verifiable-units` for the red/green unit.
- `prove-it-works` for the real run, not the summary.
- `shipping` for the independent verifier and bottom-up merge.
- `babysit` for one retry, then classify.
- `show-me-your-work` for the decision log.
- `interrogate` and `blast-radius` for run-proven findings.
- `never-block-on-the-human` for reversible work.
