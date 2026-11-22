# 0007 — Comments are for invariants, decisions live in ADRs

- Status: Accepted
- Date: 2026-11-22
- Issue: this PR

## Decision

Code comments are limited to functional directives and local invariants.
Cross-cutting rationale moves to a numbered ADR. A per-file ratchet warns when
a file gains comments; it never fails CI.

Functional directives (never counted or deleted): `@ts-expect-error`,
`@ts-ignore`, `eslint-disable`, `NOSONAR`, coverage ignores, `Stryker disable`,
`/// <reference>`, and license attribution.

A local invariant may stay in code only when all three are true:

1. It guards a concrete ordering, race, security, privacy, protocol, or
   compatibility constraint.
2. It fits in one to three lines.
3. A maintainer editing the adjacent code would otherwise break it.

Everything else is one of:

- a tautology: delete it;
- an excuse for a shortcut: fix it and delete the comment;
- stale: delete it;
- a decision: an ADR, or a local invariant under the test above.

## Why

The repository had 4,691 comments across 497 files. A full audit found most were
decision records, not noise, so deleting all of them would erase the only record
of non-obvious choices. The opposite failure was also real: a few comments
documented known hacks, and nothing stopped new prose from accumulating.

A count-based ratchet is the cheapest mechanism that changes direction without a
mass rewrite. It is deliberately asymmetric: deleting is free, adding warns.
The baseline is reviewed with the code, so raising it is a visible act.

## Consequences

- `npm run lint:comments` and the `comment budget (warn)` step in `verify check`
  report growth; CI stays green.
- `npm run lint:comments -- --update` lowers the floor after a cleanup.
- A comment that needs more than three lines is a signal to write an ADR.
- The cleanup is incremental; `@delete-comment` repeats it without a new policy
  debate.
- The first cleanup moved the cross-cutting decisions in ADRs 0008–0015 and
  deleted the tautology, stale, and excuse comments. Local invariants stay.

## Links

- `docs/development/comments.md`
- `.agents/skills/delete-comment/SKILL.md`
- `config/comment-baseline.json`
