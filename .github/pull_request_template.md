# Pull request

## Why

<!-- The problem and the approach. 1-3 short sentences. -->

<!-- For a fix: the layer that found the defect, one of review, chaos, e2e, unit,
eval, user, ci, dogfood. `npm run tests:status -- --digest` counts it. -->
Found by: <layer>

## What changed

<!-- 1-3 short bullets. Name the real symbol or path only when it carries the change. -->

## Scope and blast radius

<!-- What this covers, what it leaves out, and who or what it touches. -->

## Witness

<!--
The witness is the smallest check that fails before the fix and passes after it.
CI runs the block below when this PR changes `src/`.
Use one `test:` line and one `src:` line per changed source path. A `src:` path
may be under `src/` or `scripts/`, and may be a file this PR deletes.
A pure deletion uses `kind: removal` with `gone: <path>` and `absent: <text>` lines.
A pure refactor uses the `no-behavior-change` label instead of this block.
Keep the block empty when this PR has no source change.
-->

<!-- witness
# test: test/example.test.ts
# src: src/example.ts
-->

```bash
# Command used to prove the witness
```

Before: `FAIL` — test name, assertion, and counts
After: `PASS` — test name, assertion, and counts

## Verification

```text
npm run verify -- plan
npm run verify -- change <witness>
npm run verify -- check
```

Do not paste test counts here: they go stale after the next push. The
latest verdict comment carries the counts at its head.

## UI evidence

<!-- Required when a command, button, modal, settings row, mode, tab, or panel changes. -->
- E2E assertion: `test/e2e/specs/<spec>.e2e.ts` > `<test name>` (fails without this change)
- Screenshot: attach one image to this PR
- Waiver: <reason when there is no UI change>

## Agent review

<!-- Posted by a reviewer agent that did not write the change, after CI is green. See @verify-pr. -->

Post the verdict as a PR comment with `Verdict`, `Head`, `Reviewer`, and
`Fast lane` (cite `CI` when `ci` and `e2e` are green at the head). The `review`
check only reports it; the owner reads it before "merge".

## Attention

<!-- Anything a reviewer should inspect, or "none". -->

Do not merge this PR without an explicit "merge" from the repository owner.
