# Escaped defects

A defect that reaches a release is a missing test, not only a bad line. Add one
row per escaped defect. Keep the row after the fix.

| Date | Release | Defect | Why the tests missed it | Mutation or check that would catch it | Regression test |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

## How to use it

1. Reproduce the defect with the smallest user action.
2. Name the assertion that was missing, not the line that was wrong.
3. Add the regression test first. It must fail on the release commit.
4. Add a mutation case or a fault case if a normal unit test cannot cover it.
5. Fill the row and link the test path and line.

The mutation matrix runs nightly. A surviving mutant that matches an escaped
defect is a strong signal to add the test to the default matrix.
