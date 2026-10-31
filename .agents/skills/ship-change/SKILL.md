---
name: Ship Change
description: Use for any code change in this repo: bug, feature, refactor, or dependency upgrade. Routes the work, requires a witness test, and runs the lowest verify lane that can actually fail.
---

# Ship change

Own the change end to end. Plan, implement, verify, and report evidence.

## Non-negotiables

1. **Witness first.** Every change has the smallest check that fails before and
   passes after. For a bug, run it before the fix and keep both outputs.
2. **Lowest failing lane.** Run the cheapest tier that can actually fail for the
   risk you introduced. Do not run `dogfood` for a CSS change; do not ship a
   prompt change on unit tests alone.
3. **Counts, not exit codes.** Zero tests or all tests skipped is a failure.
4. **UI claims need more than a screenshot.** Use a committed e2e assertion, or a
   probe recording plus DOM/state metrics.
5. **No secret or vault data in a commit.**

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
3. Name the witness: the smallest assertion that would fail today.
4. Implement the smallest change that satisfies it.
5. Verify:
   - logic: `npm run verify -- change <file-or-name>`
   - types, lint, unit, bundle: `npm run verify -- ci`
   - merge gate: `npm run verify -- fast`
   - UI wiring: `npm run verify -- e2e <spec>` or `npm run probe -- --scenario <name>`
   - prompt, tool, or context: `npm run verify -- eval` plus `compare --fail-on-regression`
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

1. Baseline: `npm run verify -- fast` and record the result.
2. Bump. Prove the resolved version with `npm ls <package>` and a lockfile diff.
3. Re-run `fast`. If prompt, tool, context, or provider code changed, also run the
   eval A/B with `--fail-on-regression`.
4. For Obsidian: also run `npm run verify -- audit` and the mobile lane.

## Done means

- Witness exists and was shown failing first.
- The chosen lane is green with counts recorded.
- Feature map updated if a user-facing entry point changed.
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
