# Code comments

The 2026-11 audit and its numbers are in [comment-audit.md](comment-audit.md).

A comment is documentation with no compiler behind it. It goes stale, it grows,
and it lets a hacky implementation look intentional. This page records the
policy, the classification used by the cleanup, and the ratchet that keeps new
comments from silently accumulating.

## What a comment may say

A comment is for one of two things only:

1. A **functional directive** the toolchain reads: `@ts-expect-error`,
   `eslint-disable`, `NOSONAR`, coverage ignores, `Stryker disable`,
   `/// <reference>`, or a license attribution.
2. A **local invariant** that is cheap to state and expensive to relearn: an
   ordering constraint, a race, a security boundary, a protocol quirk, or a
   compatibility rule. Keep it one to three lines, and state the consequence of
   breaking it.

Everything else belongs somewhere else:

| Comment | Where it belongs |
|---|---|
| Restates the name, type, control flow, or a section heading | Delete it |
| Explains a non-obvious cross-cutting choice | [ADR](../adr/) |
| Admits a shortcut (`TODO`, "for now", "open question", "may be redundant") | Fix it; the cleanup list tracks the issue |
| Describes a feature | `docs/features/` or `docs/reference/` |

A decision that needs more than three lines is an ADR, not a comment.

## The four cleanup categories

The cleanup pass classifies every comment:

- **Tautology**: repeats what the adjacent code already says. Delete.
- **Excuse**: documents a hack instead of fixing it. Delete and file the fix.
- **Stale**: names a module, symbol, or behavior that is gone. Delete.
- **Decision Record**: a non-obvious choice worth keeping. Move a
  cross-cutting one to an ADR; keep a local invariant next to the code.

"Local invariant" is the only category that survives in code. It is narrower
than "decision record": if the rule would still be true after a refactor, or it
affects more than one module, it belongs in an ADR.

## Ratchet

`config/comment-baseline.json` freezes the current comment count per file. The
ratchet is deliberately asymmetric:

- Deleting comments never fails.
- Adding comments above a file's frozen count prints a warning. `npm run lint`
  (through `local/comment-budget`) and the `comment budget (warn)` step in
  `npm run verify -- check` show it. CI does not fail.
- After a deletion pass, lower the floor:

```bash
npm run lint:comments                 # warnings only
npm run lint:comments -- --list       # per-file counts
npm run lint:comments -- --update     # rewrite the frozen counts
```

The baseline is reviewed with the code. Do not raise a number to silence a
warning; delete the new comment, move its rationale to an ADR, or fix the
shortcut it documents.

## Cleanup workflow

Use `@delete-comment` for a repeat pass. The short version:

1. Extract every comment and read it in context; never classify by regex alone.
2. Delete tautology and stale comments; preserve functional directives.
3. For each excuse, file or append to the cleanup issue list, then delete the
   comment.
4. Move cross-cutting decisions to a numbered ADR and link it from the PR.
5. Run `npm run lint:comments -- --update` and commit the lower baseline.
6. Run `npm run verify -- check`. Warnings are expected; test counts are not.

The first pass's unresolved shortcuts are in
[comment-cleanup-hacks.md](comment-cleanup-hacks.md).
