# 0007 — Comments are for invariants, decisions live in ADRs

- Status: Accepted
- Date: 2026-11-22
- Issue: #417

## Decision

A code comment is either a functional directive that a tool reads or a local
invariant: an ordering, race, security, privacy, protocol, or compatibility rule
that fits in one to three lines. A choice that spans modules is an ADR. A
shortcut is fixed or filed as an issue, not explained in a comment.

New comments warn when a changed file has more comments than at the base branch.
The check never fails CI.

## Why

The repository had about 4,700 comments. An audit found that most are real
decision records, so a mass delete would remove the only record of non-obvious
choices. A few comments documented known hacks, and nothing stopped new prose
from piling up.

A hard ban would push people to delete useful context or hide it behind
directives. A warning on net growth changes the direction at low cost. It is
compared with the base branch, so it needs no baseline file that conflicts
between PRs.

## Consequences

- Deleting or rewording a comment is free. Adding one warns.
- A comment that needs more than three lines is a signal to write an ADR.
- Tools that scan source text must ignore comments. See
  `blankComments` in `scripts/lib/comments.mjs`.
- The cleanup procedure and its gotchas are in `docs/development/comments.md`.

## Links

- `docs/development/comments.md`
- `scripts/comment-budget.mjs`
