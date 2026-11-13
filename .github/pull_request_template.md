# Pull request

## Why

<!-- The problem and the approach. 1-3 short sentences. -->

## What changed

<!-- 1-3 short bullets. Name the real symbol or path only when it carries the change. -->

## Scope and blast radius

<!-- What this covers, what it leaves out, and who or what it touches. -->

## Witness

<!--
The witness is the smallest check that fails before the fix and passes after it.
CI runs the block below when this PR changes `src/`.
Use one `test:` line and one `src:` line per changed source path.
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
npm run verify -- change <witness>
npm run verify -- fast
```

Do not paste test counts here: they go stale after the next push. The
latest verdict comment carries the counts at its head.

## Break-change

<!-- Run @break-change for behavior changes and removals, or state a waiver. -->
- Report: `logs/break-change/<timestamp>/report.md` | waiver: <reason>
- Verdict: `PASS` | `FINDINGS` | `INCONCLUSIVE`

## UI evidence

<!-- Required for user-visible changes. Clips stay local; never commit them. -->
- Desktop 1280x1024 clip: `logs/break-change/<timestamp>/clips/desktop-1280x1024/session.mp4`
- Mobile 390x844 clip: `logs/break-change/<timestamp>/clips/mobile-390x844/session.mp4`
- Watch: <timestamps and mark labels>
- Waiver: <reason when no clips>

## Independent verdict

<!-- Filled in by a verifier that did not write the change. See @verify-pr. -->

- Verifier:
- Result: `PASS` | `PASS+NOTES` | `FAIL`
- Head:
- Notes:

Post the verdict as a PR comment with `Verdict`, `Head`, `Reviewer`, and
`Fast lane`. The `review` check reads that comment.

## Attention

<!-- Anything a reviewer should inspect, or "none". -->

Do not merge this PR without an explicit "merge" from the repository owner.
