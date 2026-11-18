---
name: factory
description: Orchestrate a goal that spans several PRs (refactor, feature, cleanup batch) - split it, implement each PR as the lead agent, get an agent review per PR, merge only on the owner's "merge", then propose an explore run. Use when the user gives a goal with /factory <goal>.
argument-hint: <goal, for example "refactor the UI so behavior stays the same but the architecture is simpler">
---

# Factory

The goal is the argument. You are the lead agent: you map, split, implement,
fix, and report. A reviewer agent reviews; a research agent answers read-only
questions when you ask. The owner decides the merge.

The step-by-step flow, with who does each step and its command, is the
"Factory flow" table in [testing.md](../../../docs/development/testing.md#factory-flow).
Each PR inside it follows `@ship-change`.

```bash
npm run worktree:new -- <name>                              # one PR, one worktree
npm run delegate -- research <name> "<question>"            # optional, read-only
npm run delegate -- review <pr> <name> "<focus>"            # after ci and e2e are green
```

## Map and split

1. Read the code the goal touches. For a refactor, list the behaviors that must
   not change and the test that pins each. A behavior with no test gets one
   first.
2. Cut the goal into as few PRs as the risk allows (until v1: few, larger PRs).
   Write the plan in `NEXT.md` (git-ignored): one line per PR with its witness.
3. Merge `main` into the next branch after each merge, fix conflicts, re-run
   `check`.

## Rules

- `AGENTS.md` non-negotiables apply to every PR: witness, counts, UI assertion
  plus screenshot, an agent review, merge only on "merge".
- The lead agent implements and fixes. Delegates never edit the repo: the
  sandbox gives them read access and one output file.
- A refactor PR must not change behavior. If a test must change, stop and say
  why.
- Prefer deleting code over adding layers. Report lines removed and files
  touched.
- Report per PR: what changed, the witness, the counts, the verdict.
- After a big change, or three or more merged PRs, **propose** one explore run
  (`@app`). It runs on request only.

## The reviewer agent

`scripts/delegate.sh` runs opencode (`opencode-go/deepseek-v4.1-flash` by
default, `DELEGATE_MODEL` to change it) with a sandbox: read-only tools, a shell
allowlist, no web, no `.env`, and one writable file. It cites green CI instead
of re-running `check`, proves the witness with `scripts/verify-witness.mjs`, and
writes `Verdict / Head / Reviewer / Fast lane / Behavior change` as one PR
comment. The comment is advisory: the owner reads it before "merge". A push
makes it stale; ask for a new review at the new head. Fix real findings and say
which notes you did not fix and why.
