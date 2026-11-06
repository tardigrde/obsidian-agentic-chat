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
CI runs the block below when the PR has the `behavior` or `witness` label.
Use one `test:` line and one `src:` line per changed source path.
Keep the block empty when this PR has no behavior change.
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

- `change`:
- `fast`:
- CI:

## Independent verdict

<!-- Filled in by a verifier that did not write the change. See @verify-pr. -->

- Verifier:
- Result: `PASS` | `PASS+NOTES` | `FAIL`
- Notes:

## Attention

<!-- Anything a reviewer should inspect, or "none". -->

Do not merge this PR without an explicit "merge" from the repository owner.
