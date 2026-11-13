---
name: Worktree
description: Use when a task needs its own worktree, env-dependent commands, a worktree audit, or safe cleanup. Creates a branch and worktree, links local-only files such as .env without copying secrets, and removes only work that is safe to remove.
---

# Worktree

One task, one branch, one worktree. Do not put parallel writers in the same
worktree.

## When to use

- A task needs an isolated checkout without touching `main`.
- A command needs the local `.env` from the main checkout.
- You need to list or clean up old worktrees.

## Commands

```bash
npm run worktree:new -- <name>
npm run worktree:env -- <command>
npm run worktree:list
npm run worktree:cleanup -- --dry-run
npm run worktree:cleanup -- --apply
```

`new` creates `<repo-parent>/<repo-name>-worktrees/<slug>` on branch
`wt/<slug>` from `main`, then symlinks each existing `config/worktree-links` entry.
Use `--base`, `--path`, `--branch`, and `--json` as needed.

`env` loads `.env` from the current worktree, does not overwrite exported
variables, and never prints values. `--env-file <path>` selects another file.

## Safety gates

- Default cleanup is a dry run.
- `--apply` removes only `safe` worktrees: clean and merged into the base, or a
  merged PR.
- `hold-wip`, `hold-scratch`, `hold-open-pr`, `recent`, and `review` need a human
  decision. A closed but unmerged PR is `review`, not `safe`.
- `--force` is a human-only override. It prints every path before removal.
- Branch refs survive cleanup. Committed work is not lost.
- Before removal: unlink manifest symlinks, `git worktree remove`, `rm -rf`
  ignored artifacts if the directory survives, then `git worktree prune`.

## Do not

- Copy `.env` into a worktree. Symlink it. Never commit it.
- Run `rm -rf` on a dirty worktree without a human decision.
- Run two writers in one worktree.
- Delete a branch as part of cleanup.

The audit and bucket idea is adapted from pstack's `worktree-cleanup` playbook
by Lauren Tan (MIT). Full reference: `docs/development/worktrees.md`.
