# Worktrees

One task, one branch, one worktree. A worktree gets one writer at a time.

## Create

```bash
npm run worktree:new -- fix-settings
```

This runs `git worktree add -b wt/fix-settings` from `main` at:

```text
<repo-parent>/<repo-name>-worktrees/fix-settings
```

Then it links every existing entry in `worktree-links` from the main checkout.
The manifest lists names only:

```text
node_modules
.obsidian-cache
.env
.env.local
```

`.env` is symlinked, never copied. `node_modules` is linked, so the helper does
not run `npm ci`. Use `--base`, `--path`, `--branch`, and `--json` when you need
other values.

## Run env-dependent commands

```bash
npm run worktree:env -- node scripts/verify-provider-live.mjs
npm run worktree:env -- --env-file .env.local npm run test:live
```

`env` loads `.env` from the current worktree with the existing
`scripts/live-env.mjs` parser. Already-exported variables win. Values are never
printed. If `.env` is missing, the command runs with the current environment and
prints a warning.

## List

```bash
npm run worktree:list
```

Shows path, branch, HEAD, dirty state, ahead/behind when a remote branch exists,
and the newest tracked or untracked file mtime.

## Clean up

```bash
npm run worktree:cleanup -- --dry-run   # default
npm run worktree:cleanup -- --apply
```

Cleanup classifies each non-main worktree:

| bucket | meaning |
|---|---|
| `hold-wip` | tracked uncommitted changes |
| `hold-scratch` | untracked non-ignored files |
| `hold-open-pr` | open or draft PR |
| `recent` | newest file mtime within 3 days |
| `safe` | clean and merged into base, or a merged PR |
| `review` | clean, not merged, no PR, or a closed but unmerged PR |

`--apply` removes only `safe` worktrees. `hold-wip`, `hold-scratch`,
`hold-open-pr`, `recent`, and `review` need a human decision. `--force` is a
human-only override: it prints every path it will remove, then removes unsafe
worktrees too.

Removal order is: remove the manifest symlinks, `git worktree remove`, `rm -rf`
the directory if ignored artifacts keep it alive, then `git worktree prune`.
Branch refs survive. Committed work is not lost. Uncommitted work is never
deleted without `--force`.

## Pause safely

Commit the work with a `wip:` prefix and write a short resume note before you
switch tasks:

```bash
git add -A
git commit -m "wip: fix settings validation"
```

## Secrets

`worktree-links` contains names, not values. `.env` is symlinked from the main
checkout and is ignored by git. Never copy `.env` into a worktree and never
commit it.

## Source

The audit and bucket idea is adapted from pstack's `worktree-cleanup` playbook
by Lauren Tan (MIT). The one-task-one-worktree rule follows pstack's
`opening-a-pr` worktree rules.
