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
3. **Delegate.** For each PR, in parallel (e2e lanes can run side by side):
   ```bash
   npm run worktree:new -- <name>
   npm run delegate -- ship <name> <spec.md> "<pr title>" "<review focus>"
   ```
   `ship` = work, then the script (never the worker) pushes and opens the PR from
   the worker's `logs/delegate/pr-body.md`, then the independent review. The
   shared worker rules in `spec-rules.md` go in front of every spec; the spec
   adds the exact files, the behavior, the witness test, and "Do not touch".
   A vague spec gives a vague diff. (`work` alone still exists.)
4. **Check the worker.** Read the full diff yourself while the review runs. Fix
   small gaps yourself (then run a new `review`); re-delegate large ones.
5. **Review.** `review` posts the verdict to the PR and re-runs the Review gate. On
   a PASS it also sets `no-behavior-change` (when the verdict says
   `Behavior change: none`) and `large-pr` (over 25 `src/` files or 1000 added
   lines). The reviewer cites green CI instead of re-running `fast`. Fix real notes
   before the merge and say which notes you did not fix and why.
6. **Merge.** Only after the user says "merge" (AGENTS.md rule 7); then merge each
   PR when it is green (`gh pr merge <n> --squash`). After each merge, run
   `npm run delegate -- update <next-pr> <name>` for the next PR: it merges `main`,
   takes `main`'s feature map and fixes its refs, pushes, waits for CI, posts a
   re-check, and re-runs the gate. It stops on a source conflict.
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
