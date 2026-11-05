# Trust the change, not the tool

CI cannot prove correctness. It can prove a specific claim.

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
rejects a test that passes without the fix.

Rules:

- Commit the source change first. The tool refuses dirty source paths.
- Revert only `--src` paths. Test files stay at the PR head.
- The witness command must not write to the source paths.
- The red run can fail for a compile error or a missing export. The verifier reads
  the output; a crash that never reaches the assertion is not a proven witness.

## Independent verdict

The verifier is a separate agent, ideally on a different model family. Load
`@verify-pr`. The verifier must not be the author.

The verifier:

1. checks out the PR head in a clean worktree,
2. runs the witness and confirms the counts,
3. runs `npm run verify:witness` and reads the report,
4. runs `npm run verify -- fast`,
5. checks for new module-level mutable state,
6. posts `PASS`, `PASS+NOTES`, or `FAIL` with the commands and counts.

The human reads the verdict and the `Attention` list, not the whole diff.

## Review tiers

| Tier | Examples | Review policy |
|---|---|---|
| A | test-only, docs, mechanical ownership with an isolation test | auto-merge after CI and an independent `PASS` |
| B | protocol state, persisted state, single-flight guards | human reads the witness and the changed public behavior |
| C | session lifecycle, UI behavior, data format | human reads the design, the failure tests, and the e2e/probe evidence |

If a PR cannot be explained in five lines, split it. Prefer five narrow PRs to one
large PR.

## Merge safety

These are repository settings, not files. Apply them once in GitHub:

- Protect `main`.
- Require `CI / ci` and `CI / smoke-e2e`.
- Require the branch to be up to date before merge.
- Enable the merge queue for `main`.
- Allow squash auto-merge.
- Delete the branch after merge.

Land verified PRs bottom-up. Never merge a PR above an unverified PR. If a PR is
stacked, retarget the child after the parent merges and keep its verdict only when
`git patch-id` says the patch is unchanged.

## AFK run protocol

Use this when the human steps away and wants verified PRs landed one by one.

Exit predicate:

> All planned PRs are merged to `main`. Each PR has a witness that failed before
> and passed after, an independent `PASS`, and `verify -- fast` green at its head.
> `main` is green after each merge.

Loop for each invariant, bottom-up:

1. Rebase onto `main`.
2. Run the witness on the base commit; keep the red output.
3. Apply the smallest fix.
4. Run the witness; keep the green output.
5. Run `npm run verify:witness` and `npm run verify -- fast`.
6. Open the PR with the template.
7. Spawn the independent verifier in a clean worktree.
8. On `PASS`, squash-merge. On `FAIL`, fix or stop.
9. Rebase the next PR and repeat.

Stop and report when:

- the same CI failure appears twice for the same reason,
- the verifier returns `FAIL`,
- the fix needs a product or preference decision,
- an irreversible action is required,
- `main` is red,
- the witness cannot be made deterministic.

Everything else is reversible. Proceed and log it.

Keep `decisions.tsv` for the run:

```text
ts	phase	decision	why	evidence	result
```

One row per PR, plus pivots and reverts. At the end, hand back the table and an
`Attention` section. This is the `show-me-your-work` pattern from pstack.

## What this does not cover yet

- **Mutation testing.** A surviving mutant on changed lines is the strongest
  proof that a test can fail. Add Stryker on changed files after the first batch.
- **State-space checks.** For session swap and compaction, a state × event matrix
  test is the minimum. A TLA+ model is a design tool, not a merge gate.
- **Nightly drift.** Dogfood, eval, audit, and mobile lanes still run on demand.
  Add a scheduled workflow once the per-PR lane is trusted.
- **Mutation of the mutation.** The verifier can be wrong. Cross-model
  adversarial review (`interrogate`) is the next guard.

## Sources

The process borrows from pstack:

- `tdd` and `sequence-verifiable-units` for the red/green unit.
- `prove-it-works` for the real run, not the summary.
- `shipping` for the independent verifier and bottom-up merge.
- `babysit` for one retry, then classify.
- `show-me-your-work` for the decision log.
- `interrogate` and `blast-radius` for run-proven findings.
- `never-block-on-the-human` for reversible work.
