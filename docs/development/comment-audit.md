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

4,775 comments were reviewed, including 84 functional directives.

| Area | Comments | Tautology | Excuse | Stale | Decision record |
|---|---:|---:|---:|---:|---:|
| `src/agent`, `src/llm`, `src/session`, `src/privacy` | 783 | 47 | 3 | 6 | 727 |
| `src/ui` | 803 | 17 | 3 | 1 | 782 |
| rest of `src/` | 1,208 | 15 | 4 | 2 | 1,187 |
| `test/*.test.ts` | 660 | 18 | 3 | 0 | 639 |
| `test/ui`, `test/e2e` | 575 | 10 | 0 | 2 | 563 |
| `scripts/` | 746 | 6 | 2 | 4 | 734 |
| **Total** | **4,775** | **113** | **15** | **15** | **4,632** |

Most comments in this repository are decision records. That is the main finding:
a blind deletion would remove the only record of non-obvious ordering, privacy,
protocol, and persistence choices. The cleanup therefore deletes the noise and
keeps local invariants, while the cross-cutting decisions move to ADRs.

## This pass

- 160 comments deleted or collapsed. 134 came from the audit delete list; 26
  were multi-line stale comments collapsed to one accurate line or removed.
- 78 tracked code files changed: `+59 / -230` lines.
- The comment count is **4,691 → 4,531**. The ratchet baseline is updated to
  4,531.
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

The remaining 4,531 non-functional comments occupy **8,416 physical lines**
(2,366 JSDoc, 2,165 line comments). Deleting every one would shed:

- **8,416 lines** of comment text, before blank-line cleanup;
- roughly **9,300–9,500 lines** after collapsing the blank lines that separate
  comment blocks from code.

That is the upper bound. It is not the goal: it would remove the local invariants
that keep the streaming, session, and privacy code safe. The ratchet lets the
repository shrink toward that number over several passes without a single
unreviewable diff.

## Evidence

- Extraction and counts: `npm run lint:comments -- --list`.
- Budget comparison: `npm run lint:comments -- --json`.
- The audit's per-area JSON is attached to the cleanup PR, not committed: it is
  a review artifact, not a second source of truth.
- Test counts and lane verdict: `logs/verify/<ts>/summary.json` from the PR's
  `verify -- check` run.
