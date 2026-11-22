---
name: Delete Comment
description: Use for a code-comment cleanup pass: inventory every comment, classify tautology/excuse/stale/decision-record, delete the noise, file the hacks, move decisions to ADRs, and ratchet the count down.
---

# Delete Comment

One pass, one PR. The goal is less executable prose, not zero comments. A local
invariant that prevents a real regression stays; a paragraph that restates the
code does not.

Policy and commands: [comments.md](../../../docs/development/comments.md).

## 1. Inventory

```bash
npm run lint:comments -- --list      # per-file counts
npm run lint:comments -- --json      # current vs frozen
```

Extract with the project scanner, not `grep`: comments inside strings, templates,
and regexes are false positives. `scripts/lib/comments.mjs` is the source of
truth and already skips functional directives.

## 2. Classify in context

Read every comment with the code around it. A comment is not a tautology
because it is short; it is a tautology when deleting it loses nothing the code
already says. Use these tests:

| Category | Test | Action |
|---|---|---|
| Tautology | A maintainer could recover the same statement from the adjacent code in under five seconds. Includes section headings and decorative separators. | Delete |
| Excuse | It admits a shortcut: `TODO`, `FIXME`, "for now", "temporary", "open question", "may be redundant", "keep in sync", a duplicated rule. | Delete, then file the fix |
| Stale | It names a file, symbol, UI, or behavior that no longer exists, or describes the opposite of what the code does now. | Delete |
| Decision Record | It states a non-obvious ordering, race, security, privacy, protocol, performance, or compatibility choice. | ADR if cross-cutting; keep a one-to-three-line local invariant otherwise |

Functional directives are never classified and never deleted: `@ts-expect-error`,
`@ts-ignore`, `eslint-disable`, `NOSONAR`, `istanbul`/`c8`/`v8 ignore`,
`Stryker disable`, `/// <reference>`, and license attribution.

Do not batch-classify by regex and do not let a subagent delete without a review
pass. The false positive that removes a race-condition note is invisible in
tests.

## 3. Act

- **Tautology and stale:** delete the comment, and the line with it. Collapse a
  blank line only when it was the only separator.
- **Excuse:** add the implementation fix to the PR's hack list. One entry per
  distinct shortcut: file, line, what is hacky, why it matters, and the test
  that would prove the fix. Delete the comment.
- **Decision Record:** use the next free number in `docs/adr/`. State the
  decision, why the obvious alternative is wrong, consequences, and links. If
  the decision is local, leave a short invariant comment instead and do not
  duplicate it in an ADR.

ADRs are append-only. Never rewrite an old decision to match new code; add a new
ADR that supersedes it.

## 4. Ratchet

```bash
npm run lint:comments -- --update
```

Commit `config/comment-baseline.json` with the deletion. The ratchet warns when
a file grows past its frozen count. Never raise a number to silence a warning:
delete the new comment, move the rationale, or fix the hack.

## 5. Verify and report

```bash
npm run verify -- plan
npm run verify -- check
```

Comments are not behavior, so the witness is the ratchet itself:

- `npm run lint:comments` before: the new file counts
- a temporary comment added to a frozen file: the warning appears
- the same comment deleted: the warning disappears
- `npm run lint:comments -- --update`: counts drop
- test counts from `logs/verify/<ts>/summary.json`

Report deleted comments, files touched, ADRs added, hacks filed, and the new
baseline total. Attach the hack list; a summary hides which implementations are
still weak.

## Guardrails

- Never delete a functional directive or a license header.
- Never delete a comment that names a security boundary or a regression test
  invariant without moving the same text to an ADR or the test name.
- Do not rename tests or behavior in a comment-only PR.
- Do not touch generated files, vendored code, or `main.js`.
