# Rules for every factory worker

`npm run delegate -- work|ship` puts this file in front of every spec. A spec adds
the goal, the files, the witness, and a "Do not touch" list.

## The change

- One pull request can batch several items. Make one commit per item, so a
  reviewer can read them one by one.
- A refactor must not change behavior. If an existing test must change its
  expectation, stop that item, revert it, and say why in the final message.
  Moving a test's import path is fine.
- Prefer deleting code over adding layers. No new features. No new settings.
- No import cycles: a moved module must not import the file it came from.
- Do not touch the files under "Do not touch" in the spec.
- Persisted shapes (data.json, session JSONL) must stay readable.

## The witness

- A behavior change needs a witness: write the test first, run it, and see it
  FAIL ON AN ASSERTION on the old code. A red run that dies on an import, a
  `TypeError: x is not a function`, or a setup hook is not a witness. Test new
  helpers through a code path that already exists on `main` (a CLI, an
  exported function that already exists), or assert on the result, not on the
  presence of a new export.
- Then fix it and see it PASS. Put both results, with test counts, in the final
  message.
- A pure refactor has no witness block. Write "Refactor: no runtime behavior
  change" in `logs/delegate/pr-body.md`. The reviewer confirms it and the script
  adds the `no-behavior-change` label.

## Checks

- After every item: `npx tsc --noEmit -p tsconfig.json` and the related unit tests.
- Never fix `path:line` or `path#symbol` refs in
  `.agents/skills/verify-obsidian-chat/features/` by hand. Run
  `node scripts/check-feature-map.mjs` and follow what it prints (it has a
  `--fix` mode when the map supports it).
- At the end: `npm run verify -- fast` must PASS. Report the unit and smoke e2e
  counts in the final message, not in the PR body.

## The sandbox

- Work only inside your worktree. Never edit `.git`, `.gitmodules`,
  `.gitattributes`, or `.npmrc`, and never change git or npm config. These are
  denied; a way around a denied action is a bug to report, not to use.
- If a command you need is denied, stop and say which command and why you need
  it.
- If an item is too big to finish safely, do a safe first step and say clearly
  what is left.
