---
name: factory
description: Orchestrate a goal end to end (refactor, feature, cleanup batch) - split it into small PRs, delegate each to an opencode worker, get an independent review, merge on green, then run chaos on the result. Use when the user gives a goal with /factory <goal>.
argument-hint: <goal, for example "refactor the UI so behavior stays the same but the architecture is simpler">
---

# Factory

The goal is the argument. You are the orchestrator: you decide, write specs,
review diffs, and merge. Workers do the self-contained steps. Never spawn Claude
subagents for this; use `scripts/delegate.sh` (opencode, flat-rate model). It
sandboxes each run: edits only in its worktree (or only the verdict file for a
review), a shell allowlist, no web, no `.env` reads.

## Loop

1. **Map.** Read the code the goal touches. For a refactor, list the behaviors
   that must not change and find the test that pins each one. A behavior with no
   test gets a test first (its own PR, or step 1 of the first PR).
2. **Split.** Cut the goal into PRs that are small enough for the review-gate
   budget and independent where possible. Write the plan as a section in
   `NEXT.md` (at the repo root, in `.gitignore`): one line per PR, with its witness.
3. **Delegate.** For each PR, in parallel when the files do not overlap:
   ```bash
   npm run worktree:new -- <name>
   npm run delegate -- work <name> <spec.md>   # spec: goal, files, witness, checks
   ```
   A spec names the exact files, the behavior, the witness test, and the checks.
   A vague spec gives a vague diff.
4. **Check the worker.** Read the full diff yourself. Run the witness red/green and
   `npm run verify -- fast`. Fix small gaps yourself; re-delegate large ones.
   Push and open the PR with the evidence table (see `@ship-change`).
5. **Review.** `npm run delegate -- review <pr> <name> "<focus>"`, then post
   `logs/delegate/verdict-<pr>.md` with `gh pr comment <pr> --body-file`. You post
   it from the author's account; the gate accepts that because CI sets
   `REVIEW_GATE_SINGLE_ACCOUNT=1`, and the Reviewer line names the worker. Fix real
   notes before the merge and say which notes you did not fix and why.
6. **Merge.** Only after the user says "merge" (AGENTS.md rule 7). The `review` check
   does not re-run on a new comment: re-run the latest "Review gate" run by id.
   After each merge, the next PR needs `gh pr update-branch <pr>`, then
   `npm run delegate -- recheck <pr> <name>`, post that file, re-run the gate.
7. **Chaos.** After the PRs merge, load `@chaos-monkey` and run a capped explore
   on the changed area with `--llm opencode` (explorer and miner on the
   subscription; only plugin replies cost money). Check every finding in code
   or by `--replay` before it becomes work. Real findings go to `NEXT.md`.
8. **Clean up.** Copy any `logs/chaos/` runs from the PR worktrees to the main
   checkout, then remove the merged worktrees.

## Rules

- `AGENTS.md` non-negotiables apply to every PR: witness, counts, clips or an
  explicit waiver, independent verdict, merge only on "merge".
- A refactor PR must not change behavior. If a test must change, stop and say why.
- Prefer deleting code over adding layers. Measure: lines removed, files touched.
- Report to the user per PR: what changed, the witness, counts, the verdict.
