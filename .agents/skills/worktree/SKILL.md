---
name: Worktree
description: Use when a task needs its own worktree, env-dependent commands, a worktree audit, or safe cleanup. Creates a branch and worktree, links local-only files such as .env without copying secrets, and removes only work that is safe to remove.
---

# Worktree

One task, one branch, one worktree. Never put two writers in one worktree.
Where this fits in a change: [testing.md](../../../docs/development/testing.md#factory-flow).

```bash
npm run worktree:new -- <name>               # branch wt/<name> from main, links local files
npm run worktree:env -- <command>            # run a command with the worktree's .env loaded
npm run worktree:cleanup -- --dry-run        # then --apply for the safe ones
```

`new` creates `<repo-parent>/<repo-name>-worktrees/<name>` on `wt/<name>` and
symlinks each `config/worktree-links` entry (`node_modules`, `.obsidian-cache`,
`.env`). `--base`, `--path`, `--branch`, and `--json` change the defaults.
`npm run worktree:list` shows every worktree and its bucket.

`env` loads `.env` from the current worktree, does not overwrite exported
variables, and never prints values.

## Safety gates

- Cleanup is a dry run by default.
- `--apply` removes only `safe` worktrees: clean and merged into the base, or a
  merged PR.
- `hold-wip`, `hold-scratch`, `hold-open-pr`, `recent`, and `review` need a human
  decision. A closed, unmerged PR is `review`, not `safe`.
- `--force` is for a human only. It prints every path before removal.
- Branch refs survive cleanup; committed work is not lost.
- A worktree that borrows another worktree's `node_modules` breaks when that one
  is removed: run `npm install` in the main checkout first.

## Do not

- Copy `.env` into a worktree. Symlink it. Never commit it.
- `rm -rf` a dirty worktree without a human decision.
- Delete a branch as part of cleanup.

The audit buckets are adapted from pstack's `worktree-cleanup` playbook by
Lauren Tan (MIT). Reference: [worktrees.md](../../../docs/development/worktrees.md).
