# Testing

One page for "what do I run". Deeper references:
[verification.md](verification.md) (lane internals, real-Obsidian runs, fake green),
[evals.md](evals.md) (agent-quality evals),
[trust.md](trust.md) (witness and agent review). Source of truth for every
test file: [`test/manifest.json`](../../test/manifest.json).

## Start here

```bash
npm run verify -- plan        # reads your diff, prints the exact commands, cheapest first
npm run verify -- plan --explain src/ui/chat-view.ts   # why a path needs what it needs
```

`plan` is advisory. It never plans less than `check`, marks live steps, and
`--run` executes only the deterministic ones.

## Tiers

| Tier | What | Where | Budget |
|---|---|---|---|
| T0 static | secret scan, typecheck (src, e2e, scripts), lint, Obsidian lint, circular dependencies, knip, feature map, test manifest, dependency bot config, doc commands, skip rule | `check`, CI | ≤ 30 s |
| T1 hermetic logic | vitest by domain group (`unit` project, no DOM), rendering on happy-dom (`ui` project, `test/ui/`), witness self-test | `check`, CI | ≤ 30 s |
| T2 hermetic real app | real Obsidian with scripted turns: smoke, app specs, mobile, scripted dogfood | `check` (smoke), CI (rest) | smoke ≤ 25 s, suite ≤ 110 s |
| T3 live | live specs (`test/e2e/live/`, `test/live/`), evals (canary, core, regression) | local only, needs a key | canary ≤ 3 min with `--parallel 2`; core ≤ 7 min |
| T4 exploration | chaos explore, recorded runs (`app --record`) | local, on request | per run |

## The eight lanes

| Lane | Use |
|---|---|
| `plan` | the commands this diff needs |
| `check [--no-app] [--coverage]` | merge gate: T0 + T1 + production build, the release bundle booted in Obsidian, then the smoke on the e2e bundle. `--no-app` without a display |
| `change <file...\|pattern>` | the witness loop: one or more unit files, or a `-t` name pattern |
| `app [spec...] [--mobile] [--dogfood] [--prod] [--reuse-bundle]` | real Obsidian, scripted turns; bare names resolve to `test/e2e/specs/<name>.e2e.ts`; `--dogfood` is the generated vault with its oracle; `--prod` boots the release bundle |
| `app --record <scenario> [--live]` | a recorded run (video, keyframes, metrics) of `layout-smoke` or `live-chat`; must execute a test |
| `live [spec...]` | real model or MCP calls; local only |
| `eval [args]` | live evals: `--canary`, `--suite core\|regression`, `--runs N`, `--parallel N`; no arguments prints the core plan ([evals.md](evals.md#names)) |
| `explore [--mode explore --live\|--mode smoke]` | chaos explore in a throwaway vault: leads, not proof |
| `release` | `check --no-app`, full app suite, mobile specs, scripted dogfood |

`npm run check:cycles` uses madge and has an empty allowlist: any import cycle
in `src/` fails. Move a shared type or helper to a neutral module instead of
allowlisting the cycle. The intended layering is in
[architecture.md](architecture.md#layering).

`knip` fails on unused files, dependencies, unlisted binaries, and unresolved
imports. Export/type/duplicate checks are off: the plugin's module exports are
an internal surface, not a public API. `npm run knip` runs the same check
locally.

All run as `npm run verify -- <lane>`. Each run writes
`logs/verify/<ts>/summary.json` and `run-result.json` (verdict, mode, command,
counts, cost, artifacts: one shape for every lane, recorded runs and explore
included), prints a per-tier counts line, and appends to `logs/history.jsonl`.

## What to run, by change

| Change | Commands | Proves |
|---|---|---|
| docs only | `check` (+ `npm run docs:build` for `docs/`) | links build, doc commands exist |
| test only | `change <test>`, then `check` | the new test runs; the suite is consistent |
| one module / logic bug | `change <test>` red then green, then `check` | the witness, then no regression |
| UI (command, panel, row, tab, mode) | `check` + `app <spec>` (+ `app --mobile`) | wiring and lifecycle in real Obsidian |
| agent, prompt, tool description | `check` + `app --dogfood` + `eval --canary` (live); a `Signal` needs `eval:ab` | correctness, tool choice, cost vs the baseline |
| settings or persisted shape | `check` (upgrade fixtures are unit tests) + `app settings-ui` | save, reload, migration |
| provider or live path | `live <spec>` | the real API |
| `scripts/`, CI, gates | `change <script test>` + `check` | the gate still catches what it should |
| dependency or Obsidian upgrade | `check` + `app` (+ eval if the model path changed) | boot and behavior |
| big change (new tool, new UI entry point, prompt rewrite, 3+ merged PRs) | the above, then **propose** `explore` to the owner | leads for a human |
| eval case or baseline | `eval:ab --case <ids>`, then `eval --suite core --runs 3 --write-baseline` | pass^k, cost, time, significance |
| release | `release` + `eval --suite core` + a real-device mobile smoke (manual) | the full picture |

No display here? Run `check --no-app` and let CI run the app jobs. On a desktop,
run headed lanes on a nested display: `npm run nested -- npm run verify -- app smoke`.

## Rules

The eight rules are in [trust.md](trust.md#the-eight-rules): merge only on
"merge", cite the summary and counts, never green by skipping, no model in CI (except the advisory OpenCode review),
never scripted as live, no retries, no `no-behavior-change` for a behavior
change, every test file in the manifest. `check` enforces the skip rule and the
manifest.

## Factory flow

One change is one PR (`@ship-change`); a goal of several PRs is the factory
(`@factory`). The lead agent implements and fixes; delegates only review and
research.

| Step | Who | Command |
|---|---|---|
| map the goal, list the behaviors and their tests | lead agent | read the code |
| split into as few PRs as the risk allows | lead agent | one line per PR in `NEXT.md` |
| research, when asked | research agent | `npm run delegate -- research <name> "<question>"` |
| one worktree per PR | lead agent | `npm run worktree:new -- <name>` |
| plan, witness, change, verify | lead agent | `npm run verify -- plan`, then what it prints |
| open the PR | lead agent | `gh pr create` with the template: witness block, counts line, screenshot for UI |
| mark the PR ready (a draft gets no `e2e` and no OpenCode finder) | lead agent | `gh pr ready <pr>` |
| agent review, after `ci` and `e2e` are green; waits for the OpenCode finder | reviewer agent | `npm run delegate -- review <pr> <name> "<focus>"` |
| fix every confirmed finding, new review at the new head | lead agent | push, then review again |
| merge | owner | only after the owner writes "merge" |
| after a big change or 3+ merged PRs | lead agent proposes, owner decides | `npm run verify -- explore --mode explore --live` |
| clean up | lead agent | `npm run worktree:cleanup -- --dry-run`, then `--apply` |

## Evidence

- **Logic:** the witness. Red before, green after, with counts. CI runs the PR's
  `witness` block ([trust.md](trust.md)). A source may live in `src/` or
  `scripts/`, and may be a file the PR deletes. A pure deletion uses
  `kind: removal` with `gone:` paths and `absent:` texts.
- **UI:** a committed e2e assertion that fails without the change, plus one
  screenshot attached to the PR. No video is required.
- **Live:** the run result with `mode: live`, the model, and the cost.
- **Agent review:** a reviewer agent that did not write the change posts one
  verdict comment after CI is green. It is advisory: the owner reads it before
  "merge". It is agent review with evidence, not an independent human review.

## Memory

```bash
npm run tests:status    # flaky tests, slower steps and tests, last red per lane, live cost (< 1 s)
npm run logs:prune      # dry run; add -- --apply to delete old runs under logs/
```

History lives in the main worktree, so every worktree's runs land in one file.
It is advisory: nothing fails on it. `AGENTIC_CHAT_HISTORY=0` turns it off for a run.

## Where a UI check goes

| Question the check answers | Layer |
|---|---|
| What does the view render for this event, state, or click? | `test/ui/` (happy-dom, the real `ChatView` via `mountChatView`) |
| Which composer state are we in: idle, streaming, approval pending, stopped, error? | `test/ui/chat-view-states.test.ts` |
| Does it fit the window, scroll, or wire into Obsidian (commands, leaves, settings tab)? | `test/e2e/specs/` (real Obsidian) |

`test/ui/` runs the real view and `AgentService`; only the model is scripted.
The Obsidian API there is `test/ui/support/obsidian-dom.ts`. happy-dom has no
layout engine: sizes and scrolling stay in e2e.

## Hermetic T1

No network (the offline guard throws on a non-loopback host), no fixed ports
(`listen(0)`), no real waits (`withFakeClock` in `test/support/fake-clock.ts`),
one fake DOM (happy-dom) and one fake adapter (`test/support/fake-adapter.ts`).
Coverage and mutation are advisory: CI prints diff coverage; `npm run mutation`
is a weekly local run ([mutation.md](mutation.md)).

## Adding a test

1. Put it next to its peers and make sure a group in `test/manifest.json` matches
   it (`node scripts/check-test-manifest.mjs --list` shows the groups).
2. If no group fits, add one with a tier, triggers, needs, budget, command, and why.
3. Run `npm run verify -- plan --explain <test>` to see what it will trigger.
