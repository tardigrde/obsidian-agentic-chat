---
name: Ship Change
description: Use for any code change in this repo: bug, feature, refactor, or dependency upgrade. Routes the work, requires a witness test, and runs the lowest verify lane that can actually fail.
---

# Ship change

Own the change end to end. Plan, implement, verify, and report evidence.
Commands, tiers, and rules: [testing.md](../../../docs/development/testing.md).
Start every change with `npm run verify -- plan`.

## Non-negotiables

1. **Witness first.** Every change has the smallest check that fails before and
   passes after. For a bug, run it before the fix and keep both outputs.
2. **Lowest failing lane.** Run the cheapest tier that can actually fail for the
   risk you introduced. Do not run `dogfood` for a CSS change; do not ship a
   prompt change on unit tests alone.
3. **Counts, not exit codes.** Zero tests or all tests skipped is a failure.
4. **UI evidence is an assertion plus a screenshot.** If the change adds,
   removes, or changes a command, button, modal, settings row, mode, tab, or
   panel, commit an e2e assertion that fails without it and attach one
   screenshot to the PR. A screenshot alone is not a verdict; no video is
   required. A removal uses a `kind: removal` witness.
5. **Prompt or tool changes need the eval.** A change to the system prompt, a
   tool description, or the agent loop runs `npm run verify -- eval --suite core
   --runs 3` (live, local) against the baseline before it ships.
6. **No secret or vault data in a commit.**

## Route

| request | route |
|---|---|
| Bug report | Reproduce on the matching surface first. Deterministic replay or e2e, not a guess. Then bisect, fix, and re-run the repro. |
| New or changed behavior | Write the feature-map entry and name the entry points before code. Then the smallest implementation plus the witness. |
| Refactor | Behavior preserving. Capture the baseline, change shape, prove the same checks still pass. |
| Dependency or Obsidian upgrade | Capture the baseline, bump, prove the resolved version, then re-run behavior checks. |
| Idea with unknown behavior | Do not implement to spec. Run `@probe-feature`, decide from evidence, then come back. |

## Feature loop

1. Read the matching file in
   `.agents/skills/verify-obsidian-chat/features/`.
2. List every user entry point the change touches. Slash command, palette
   command, settings tab, composer control, drag and drop, agent tool, subagent.
   For each changed entry point, name the e2e assertion that will prove it.
3. Name the witness: the smallest assertion that would fail today.
4. Implement the smallest change that satisfies it.
5. Verify:
   - logic: `npm run verify -- change <file-or-name>`
   - types, lint, unit, bundle: `npm run verify -- check --no-app --coverage`
   - merge gate: `npm run verify -- check`
   - UI wiring: `npm run verify -- app <spec>` (on a desktop, wrap it as
     `npm run nested -- <command>` so Obsidian does not steal the cursor) or
     `npm run probe -- --scenario <name>`
   - prompt, tool, or context: `npm run verify -- eval` plus `compare --fail-on-regression`,
     then the tool-use A/B (see "Evals" below)
6. Update the feature map: entry points, proof command, last verified date.
7. Report evidence: command, exit code, counts, artifact path.

## Bug loop

1. Reproduce on the same surface a user would use. If it is UI, drive the real
   Obsidian app; if it is agent behavior, use `test/helpers/agent-replay.ts`.
2. If the repro is not reproducible, tighten the conditions or instrument until
   it fires. Do not ship a "might fix" change.
3. Stage the failing repro before the fix in git history.
4. Fix the root cause. A guard is a fix only when the state it handles is
   legitimate.
5. Re-run the repro. Unit tests show branch behavior, not bug absence.

## Upgrade loop

1. Baseline: `npm run verify -- check` and record the result.
2. Bump. Prove the resolved version with `npm ls <package>` and a lockfile diff.
3. Re-run `check`. If prompt, tool, context, or provider code changed, also run the
   eval A/B with `--fail-on-regression`.
4. For Obsidian: also run `AGENTIC_CHAT_DESIGN_AUDIT=1 AGENTIC_CHAT_DESIGN_AUDIT_MODE=sidebar npm run verify -- app design-audit` and the mobile lane.

## Evals: three objectives, one Pareto frontier

The evals optimize correctness, cost, and time together. They are not a
pass-rate harness. The goal is the Pareto frontier of that space, for the
plugin and for the harness. Rules:

- Report all three axes for every A/B: pass^3, billed USD per run, and median
  case time. `--compare` prints a Pareto verdict (`dominates`, `dominated`,
  `trade-off`, `same`, `incomplete`). A `trade-off` is not a win; name it.
- Hold everything fixed but the one variable: suite, model, reasoning level,
  vaults, run count.
- No cheating: never weaken a check, never edit a case only to move its pass
  rate, never cut work the task needs to look cheaper or faster. Fix a case
  only when it is unfair (ambiguous, impossible, wrong grader).
- Keep it cheap: `--smoke` (1 run per case) per change; full `core` x 3 only for
  a model, prompt, tool, or context change, at most once per PR. Do not tune a
  suite toward a pass-rate target.

Details: `docs/development/verification.md`, section "Tool-use evals".

## Done means

- Witness exists and was shown failing first.
- The chosen lane is green with counts recorded.
- Feature map updated if a user-facing entry point changed.
- Changed entry points have desktop and mobile-width clips, or an explicit waiver.
- Evidence is in the response, not just "it works".

## Promotion

| finding | promote to |
|---|---|
| Bug found live | deterministic replay test |
| New entry point | feature map plus e2e assertion |
| Rule broken twice | lint rule, script check, or CI gate |
| Layout regression | assertion in `test/e2e/support/layout.ts` |
| Flaky test | fix the observation or fixture; never add a retry |

Prefer no test over a bad test. A bad test mocks the subject, encodes the current
implementation, or would be deleted immediately after proving the fix.

## Read next

- `@verify-obsidian-chat` for the real app and the feature map.
- `@probe-feature` for exploratory work.
- `docs/development/verification.md` for lanes and the fake-green list.
