# AGENTS.md

## Process

Five skills carry the process. They live in `.agents/skills/` (`.claude/skills`
links there), so Claude Code, OpenCode, Codex, and other agents that read that
convention get the same workflow.

| skill | use for |
|---|---|
| `@ship-change` | one change end to end: bug, feature, refactor, upgrade |
| `@factory` | a goal that spans several PRs: split, implement, agent review, merge on "merge" |
| `@verify-pr` | agent review of a PR you did not write; red/green witness proof |
| `@app` | real Obsidian runs: specs, recorded runs, dogfood, chaos explore, the feature map |
| `@worktree` | one task per worktree, env-linked commands, safe cleanup |

Renamed in #393 (this note stays for one release): `@verify-obsidian-chat`,
`@probe-feature`, and `@chaos-monkey` are now `@app`; `@break-change` was
deleted (a removal uses a `kind: removal` witness).

The lead agent implements and fixes. A reviewer agent (`npm run delegate --
review`) reviews; a research agent (`npm run delegate -- research`) answers
read-only questions when asked. Neither edits the repo.

Match the weight of the process to the change:

- One-line fix, typo, or a check you can run directly: skip the ceremony and run
  the targeted lane.
- A behavior change that can break something non-obvious, or one that touches
  several files: load `@ship-change`.
- A claim about the UI, settings, or a real user journey, or "I do not know what
  correct looks like yet": also load `@app`.

Do not load them all at once. Each skill names the next one when it needs it.

After a big change (a new tool, a new UI entry point, a prompt rewrite, or 3+
merged PRs), **propose** a chaos explore run to the owner
(`npm run verify -- explore --mode explore --live`). Do not run it unasked: it
is on request only.

Put each rule in the lowest layer that can enforce it: `AGENTS.md` routes,
skills hold procedure, `scripts/` and CI hold gates.

## Non-negotiables

1. Every change needs a witness: the smallest check that fails before and passes
   after. For a bug, run it before the fix and paste both results.
2. Never claim done without running the lowest `verify` lane that can actually
   fail for the risk you introduced, and citing its
   `logs/verify/<ts>/summary.json` and per-tier counts line.
3. Report test counts, not only exit codes. Zero tests or all tests skipped is a
   failure, not a pass. The only allowed skip in unit and app tests is
   `it.skip("flaky #<open issue>: ...")`.
4. UI claims need a committed e2e assertion that fails without the change, plus
   one screenshot attached to the PR. A screenshot alone is not a verdict.
5. Never commit secrets, vault plugin data, or generated sessions.
6. A merge-ready PR has an agent review with evidence: a verdict comment from a
   reviewer agent that did not write it, posted after CI is green. It is
   advisory (the owner reads it); a green check is not a verdict.
7. Never merge a PR unless the user explicitly says "merge". Green checks are not
   permission.
8. Never call a model from CI, and never present a scripted run as live. The
   one exception is the advisory `OpenCode review` job: it is not a gate.

## Testing

Read [docs/development/testing.md](docs/development/testing.md): tiers, the
eight lanes, what to run for each kind of change, the factory flow, the rules,
and the evidence.
The first command is always:

```bash
npm run verify -- plan                           # the exact commands this diff needs
```

The ones you will use most:

```bash
npm run verify -- change test/settings.test.ts   # the witness loop (several files, or a -t pattern)
npm run verify -- check                          # merge gate; --no-app without a display
npm run verify -- app settings-ui                # real Obsidian, one spec (scripted turns)
npm run verify -- eval --canary                  # a prompt or tool change: 5 cases x 5 runs (live)
npm run verify:witness -- --base origin/main --test-file <test> --src <src...>
npm run tests:status                             # flaky, slower, last red per lane
```

Every test file is listed in `test/manifest.json`. Lane internals, real-Obsidian
runs, and proxies: [docs/development/verification.md](docs/development/verification.md).
Evals: [docs/development/evals.md](docs/development/evals.md).
Witness and agent review: [docs/development/trust.md](docs/development/trust.md).

## Fast feedback loop

Use `~/MyTestVault` as the local dogfood vault unless the user names another vault.

```bash
npm run install:local -- ~/MyTestVault
npm run dev:vault -- ~/MyTestVault
npm run dogfood -- ~/MyTestVault
```

`dev:vault` installs the plugin under
`~/MyTestVault/.obsidian/plugins/agentic-chat/`, creates `.hotreload`, and writes
esbuild output directly there. For automatic reloads, install and enable
`pjeby/hot-reload` in the same vault. Without it, reload from DevTools:

```js
await app.plugins.disablePlugin("agentic-chat");
await app.plugins.enablePlugin("agentic-chat");
```

`dogfood` enables the local plugin, starts the watcher, opens the vault when
possible, and tails session JSONL plus e2e artifacts. Use
`--once --no-open --no-tail` for a non-interactive build/install check.

## Worktrees

One task, one branch, one worktree. `config/worktree-links` names the local-only files
to symlink, so `.env` is never copied.

```bash
npm run worktree:new -- <name>
npm run worktree:env -- <command>
npm run worktree:list
npm run worktree:cleanup -- --dry-run
```

`--apply` removes only safe worktrees. Read
[docs/development/worktrees.md](docs/development/worktrees.md) and `@worktree`.

## Providers and secrets

OpenWebUI or any OpenAI-compatible gateway:

- Provider: `OpenAI-compatible`
- Base URL: the gateway base whose `/chat/completions` endpoint is valid; for
  OpenWebUI this is usually `http://localhost:3000/api`
- API key: the gateway bearer token
- Model: the model id exposed by the gateway

Never commit vault plugin data:

```text
~/MyTestVault/.obsidian/plugins/agentic-chat/data.json
~/MyTestVault/.obsidian/plugins/agentic-chat/sessions/
```

Environment variables are for scripts and live harnesses, not the plugin UI:

```bash
AGENTIC_CHAT_VAULT=~/MyTestVault
OBSIDIAN_VAULT=~/MyTestVault
AGENTIC_CHAT_BASE_URL=https://openrouter.ai/api/v1
AGENTIC_CHAT_API_KEY=...
AGENTIC_CHAT_MODEL=...
```
