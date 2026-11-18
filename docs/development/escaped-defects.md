# Escaped defects

A defect that reaches `main` or a release is a missing test, not only a bad
line. This page is data, not a template: the table below is generated from the
`Found by:` line of merged fix PRs (#393 T25).

```bash
npm run tests:status -- --digest --write-defects   # regenerate the table
npm run tests:status -- --digest [--since <iso>] [--until <iso>] [--classify]
```

The digest is weekly and local. It prints the gate reds of `ci`, `witness`, and
`review` by conclusion (and, with `--classify`, CI reds by cause: real, flake,
infra, process), the flaky tests in the local history, and the catches per
layer. It is a triage aid; it never fails a build.

First digest, the audit window 2026-11-11T06:27Z .. 2026-11-16T16:33Z: `ci` 13
red of 282, `witness` 29 red of 390, `review` 172 red of 1000 (the counts of the
#393 audit).

## Fix PRs by the layer that found the defect

`Found by:` values: `review`, `chaos`, `e2e`, `unit`, `eval`, `user`, `ci`,
`dogfood`.

<!-- generated: defects start -->
| Merged | PR | Fix | Found by |
|---|---|---|---|
| — | — | no fix PR with a `Found by:` line yet | — |
<!-- generated: defects end -->

## When a defect escapes

1. Reproduce it with the smallest user action.
2. Name the assertion that was missing, not the line that was wrong.
3. Add the regression test first. It must fail on the commit that shipped it.
4. Write `Found by: <layer>` in the fix PR body, then regenerate the table.
