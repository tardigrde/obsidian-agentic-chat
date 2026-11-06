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
  --test-file test/session-activation.test.ts \
  --src src/agent/session-activation.ts
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

The `Witness` workflow runs on every pull request from this repository.

1. It always runs `npm run verify:witness -- --self-test`.
2. It reads a witness block from the PR body.
3. It runs the declared witness against the pull request base commit.

The workflow accepts a test file and source paths, never a shell command. CI
supplies the base, so a PR cannot choose its own comparison point.

```markdown
<!-- witness
test: test/session-activation.test.ts
src: src/agent/session-activation.ts
-->
```

A PR with the `behavior` or `witness` label must have a non-empty block. A PR
with no block and neither label skips the witness run. Add a second `src:` line
for each changed source path.

Fork PRs skip this job. Import the branch, run the witness, and add the verdict
before you review the code.

## Independent verdict

The verifier is a separate agent, ideally on a different model family. Load
`@verify-pr`. The verifier must not be the author.

The verifier:

1. checks out the PR head in a clean worktree;
2. runs the witness and confirms the counts;
3. runs `npm run verify:witness` and reads the report;
4. runs `npm run verify -- fast`;
5. checks for new module-level mutable state;
6. posts `PASS`, `PASS+NOTES`, or `FAIL` with the commands and counts.

The human reads the verdict and the `Attention` list, not the whole diff. A
verdict is evidence, not permission. The merge rule still applies: do not merge
without an explicit "merge" from the repository owner.

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
- **Nightly drift.** Dogfood, eval, audit, and mobile lanes still run on demand.

## Sources

The process borrows from pstack:

- `tdd` and `sequence-verifiable-units` for the red/green unit.
- `prove-it-works` for the real run, not the summary.
- `shipping` for the independent verifier and bottom-up merge.
- `babysit` for one retry, then classify.
- `show-me-your-work` for the decision log.
- `interrogate` and `blast-radius` for run-proven findings.
- `never-block-on-the-human` for reversible work.
