# Pull request

## Why

<!-- The problem and the approach. 1-3 short sentences. -->

## What changed

<!-- 1-3 short bullets. Name the real symbol or path only when it carries the change. -->

## Scope

<!-- What this covers and what it deliberately leaves out. -->

## Blast radius

<!-- Who or what this touches, and why that is safe or risky. -->

## Witness

<!-- The smallest check that fails before the fix and passes after it. -->

```bash
# Command used to prove the witness
```

Before: `FAIL` — test name, failure reason
After: `PASS` — test name, test counts

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
