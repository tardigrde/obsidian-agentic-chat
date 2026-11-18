---
name: Ship Change
description: Use for any code change in this repo: bug, feature, refactor, or dependency upgrade. Routes the work, requires a witness test, and runs the lowest verify lane that can actually fail.
---

# Ship change

Own one change end to end: plan, implement, verify, report evidence. Commands,
tiers, and rules: [testing.md](../../../docs/development/testing.md).

```bash
npm run verify -- plan                 # first: the exact commands this diff needs
npm run verify -- change <test>        # the witness loop: red before, green after
npm run verify -- eval --canary        # a prompt, tool, or agent-loop change (live, local)
```

Run every command `plan` prints; it always ends with `check`, the merge gate.

## Non-negotiables

1. **Witness first.** The smallest check that fails before and passes after.
   For a bug, run it before the fix and keep both outputs.
2. **Lowest failing lane.** The cheapest tier that can fail for the risk you
   added. No dogfood for a CSS change; no prompt change on unit tests alone.
3. **Counts, not exit codes.** Zero tests or all skipped is a failure.
4. **UI evidence:** a committed e2e assertion that fails without the change,
   plus one screenshot in the PR. A removal uses a `kind: removal` witness.
5. **Prompt or tool change: the canary.** A change to the system prompt, a tool
   description, or the agent loop runs the canary (5 cases x 5 runs, about
   $0.03; add `--parallel 2` to halve the wall time) and pastes its table in the
   PR. One case outside its interval is `Weak`: run it once more. A `Signal` (a
   strong move, or two cases the same way) needs `eval:ab` on those cases before
   you ship.
6. **No secrets, vault data, or sessions in a commit.**

## Route

| Request | Route |
|---|---|
| Bug | Reproduce on the user's surface first (replay for agent behavior, e2e for UI). Then fix the root cause and re-run the repro. |
| New or changed behavior | Name the entry points and their feature-map rows before code. Then the smallest change plus the witness. |
| Refactor | Behavior stays. Capture the baseline, change the shape, prove the same checks pass. |
| Dependency or Obsidian upgrade | Baseline, bump, prove the resolved version (`npm ls`, lockfile), re-run behavior checks. |
| Unknown correct behavior | Do not build to a guess. One recorded run with one falsifier (`@app`), then decide. |

## Feature loop

1. Read the matching file in `.agents/skills/app/features/`.
2. List every entry point the change touches: slash command, palette command,
   settings row, composer control, agent tool, subagent. Name the e2e assertion
   for each changed one.
3. Name the witness and watch it fail.
4. Implement the smallest change that makes it pass.
5. Run what `plan` prints. On a desktop, wrap app runs in `npm run nested --`.
6. Update the feature-map row: entry points, proof, status.
7. Report: command, exit code, counts, the `run-result.json` path.

## Bug loop

1. Reproduce where a user would see it. Not reproducible? Tighten the
   conditions or instrument until it fires. No "might fix".
2. Commit the failing repro before the fix.
3. Fix the root cause. A guard is a fix only when the state it handles is
   legitimate.
4. Re-run the repro. Unit tests show branch behavior, not bug absence.

## Evals

Correctness, cost, and time are judged together; a trade-off is not a win.
Hold everything fixed but one variable. Never weaken a check or tune a case to
move a number. A new `core` baseline (12 cases x 3 runs) at most once per PR.
Details: [evals.md](../../../docs/development/evals.md).

## Done means

- The witness exists and was shown failing first.
- The lanes `plan` printed are green, with counts.
- Changed entry points have an e2e assertion, a screenshot, and a current
  feature-map row.
- A prompt or tool change has its canary table in the PR.
- The evidence is in the report, not "it works".

## Test quality

Prefer no test over a bad test. A bad test mocks the subject, mirrors the
implementation, or would be deleted right after it proved the fix.

## After the change

A reviewer agent posts one verdict after CI is green (`@verify-pr`). The owner
merges only on "merge". After a big change (a new tool or entry point, a prompt
rewrite, three or more merged PRs), propose an explore run (`@app`).
