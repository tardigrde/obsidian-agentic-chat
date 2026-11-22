# Code comments

A comment is documentation with no compiler behind it. It goes stale, it grows,
and it can make a hack look intentional. This page says what a comment may
contain, how a cleanup pass works, and how new comments are kept in check.

## What a comment may say

A comment is for one of two things:

1. A **functional directive** that a tool reads: `@ts-expect-error`,
   `eslint-disable`, `NOSONAR`, coverage ignores, `Stryker disable`,
   `/// <reference>`, or a license attribution. Never count, change, or delete
   these.
2. A **local invariant**: a rule that is cheap to state and costly to relearn.
   It guards an ordering, a race, a security or privacy boundary, a protocol
   quirk, or a compatibility rule. Write it in one to three lines. Say what
   breaks if the rule is broken.

Everything else goes somewhere else:

| The comment | What to do |
|---|---|
| Repeats the name, the type, the control flow, or a section heading | Delete it |
| Names a file, symbol, or UI that no longer exists | Delete it |
| Admits a shortcut (`TODO`, "for now", "may be redundant") | Fix the code, or file an issue. Then delete the comment |
| Explains a choice that spans more than one module | Write an [ADR](../adr/) |
| Describes a feature | `docs/features/` or `docs/reference/` |

A comment that needs more than three lines is an ADR.

## New comments warn

`npm run lint:comments` compares each changed file with the merge base of
`origin/main`. It warns when a file has more comments than it had at the base.
The same check runs as the `comment budget (warn)` step in
`npm run verify -- check`. It never fails CI.

- Only a net increase warns. Deleting a comment, or rewording one, is free.
- The warning names the comments that are new, not the ones that were there.
- There is no baseline file to keep up to date. A branch that is 100 comments
  over the base has the same warning as a branch that is one over.

```bash
npm run lint:comments                  # changed files vs origin/main
npm run lint:comments -- --base HEAD~3 # another base
npm run lint:comments -- --list        # every file with its count
npm run lint:comments -- --strict      # exit 1 on an increase (local use)
```

## A cleanup pass

One pass is one PR. The goal is less prose, not zero comments.

1. List the comments with `npm run lint:comments -- --list`. Take one area at a
   time. Use the scanner, not `grep`: markers inside strings, templates, and
   regexes are not comments.
2. Read each comment with the code around it. Delete a tautology or a stale
   comment. Keep a local invariant. For an excuse, file the fix in an issue and
   delete the comment.
3. Move a cross-cutting decision to an ADR, with the next free number. Link it
   from the PR.
4. Run `npm run verify -- plan`, then `npm run verify -- check`. Quote the test
   counts from `logs/verify/<ts>/summary.json`.

Do not change behavior in a comment-only PR. A shortcut that a comment hid is a
separate change with its own witness.

## Gotchas

- **A deleted comment can hide a race.** A short comment such as "must run
  before X" looks like noise and is the only record of an ordering rule. Read
  the code around it before you delete it. A regex or a script cannot judge it,
  and tests will not fail.
- **Check what else reads comments.** Some scripts scan source text, and a
  reworded comment can trip them. The mobile check once flagged the word
  "Buffer" in a comment. Scanners should blank comments first with
  `blankComments` in `scripts/lib/comments.mjs`.
- **Empty `catch` and `{}` blocks.** Deleting the only comment in one trips
  `no-empty`. Keep a short comment that says why the error is ignored.
- **Return-value comments are contracts.** "Returns false when already loaded"
  is behavior that callers rely on. Keep it, or move it to a test name.
- **Do not edit generated or vendored files**, or `main.js`.
- **Keep the ADR index in step.** Add a row to
  [docs/adr/index.md](../adr/index.md) when you add an ADR.
- **ADRs are append-only once merged.** Do not rewrite an old decision to match
  new code. Write a new ADR that supersedes it.
