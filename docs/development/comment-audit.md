# Comment audit — 2026-11-22

One pass over every code comment in `src/`, `test/`, and `scripts/`.

## Method

`scripts/lib/comments.mjs` extracts real comments with the TypeScript AST. It
ignores `//` inside strings, templates, regexes, and URLs, and excludes
functional directives (`@ts-*`, `eslint-*`, `NOSONAR`, coverage ignores, Stryker
disables, `/// <reference>`, license attribution).

Six independent reviews covered disjoint areas and read every comment in
context before classifying it. The categories and actions are in
[comments.md](comments.md):

- tautology and stale: delete;
- excuse: delete and add the implementation fix to
  [comment-cleanup-hacks.md](comment-cleanup-hacks.md);
- decision record: cross-cutting ones move to an ADR; a local invariant may
  stay as one to three lines.

The rule was deliberately conservative. A comment that explains **why** is not
a tautology, even when it is short. A test comment that explains what a
non-obvious assertion protects is a decision record.

## Inventory

4,691 comments were classified. Another 84 are functional directives and were
preserved without classification.

| Area | Comments | Tautology | Excuse | Stale | Decision record |
|---|---:|---:|---:|---:|---:|
| `src/agent`, `src/llm`, `src/session`, `src/privacy` | 780 | 47 | 3 | 6 | 724 |
| `src/ui` | 802 | 17 | 3 | 1 | 781 |
| rest of `src/` | 1,202 | 15 | 4 | 2 | 1,181 |
| `test/*.test.ts` | 658 | 18 | 3 | 0 | 637 |
| `test/ui`, `test/e2e` | 573 | 10 | 0 | 2 | 561 |
| `scripts/` | 676 | 6 | 2 | 4 | 664 |
| **Total** | **4,691** | **113** | **15** | **15** | **4,548** |

Most comments in this repository are decision records. That is the main finding:
a blind deletion would remove the only record of non-obvious ordering, privacy,
protocol, and persistence choices. The cleanup therefore deletes the noise and
keeps local invariants, while the cross-cutting decisions move to ADRs.## This pass

- 154 comments deleted or collapsed (4,691 → 4,537). 134 came from the audit
  delete list; the rest were multi-line stale comments collapsed to one
  accurate line or removed.
- 73 modified code files: `+49 / -231` lines. The new lint/skill/test files add
  351 lines; they are not part of the comment deletion.
- The ratchet baseline is updated to 4,537.
- 9 ADRs added (0007–0015); the index is [docs/adr](../adr/index.md).
- 22 follow-up shortcuts are listed in
  [comment-cleanup-hacks.md](comment-cleanup-hacks.md).

Kept on purpose:

- Functional directives: 84.
- Local invariants next to the code they guard (for example, "a late delta must
  not append raw text over the final render"). Their cross-cutting rationale is
  in an ADR; the one-line guard stays.
- License attributions in `src/session/jsonl.ts`, `src/session/session-manager.ts`,
  and the vault modules.

## If every comment were deleted

The remaining 4,537 non-functional comments occupy **8,422 physical lines**
(2,366 JSDoc, 2,169 line comments). Deleting every one would shed:

- **8,422 lines** of comment text, before blank-line cleanup;
- roughly **9,300–9,500 lines** after collapsing the blank lines that separate
  comment blocks from code.

That is the upper bound. It is not the goal: it would remove the local invariants
that keep the streaming, session, and privacy code safe. The ratchet lets the
repository shrink toward that number over several passes without a single
unreviewable diff.

## Evidence

- Extraction and counts: `npm run lint:comments -- --list`.
- Budget comparison: `npm run lint:comments -- --json`.
- The per-area audit JSON was the review input, not a committed second source of
  truth. `npm run lint:comments -- --list` reproduces the current counts.
- Test counts and lane verdict: `logs/verify/<ts>/summary.json` from the PR's
  `verify -- check` run.
