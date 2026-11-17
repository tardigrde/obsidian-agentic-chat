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
| T0 static | secret scan, typecheck (src, e2e, scripts), lint, Obsidian lint, feature map, test manifest, doc commands, skip rule | `check`, CI | ≤ 30 s |
| T1 hermetic logic | vitest by domain group, witness self-test | `check`, CI | ≤ 30 s |
| T2 hermetic real app | real Obsidian with scripted turns: smoke, app specs, mobile, scripted dogfood | `check` (smoke), CI (rest) | smoke ≤ 25 s, suite ≤ 110 s |
| T3 live | live specs (`test/e2e/live/`, `test/live/`), tool-use evals | local only, needs a key | 1-15 min |
| T4 exploration | chaos explore, probes, design audit | local, on request | per run |

## The eight lanes

| Lane | Use |
|---|---|
| `plan` | the commands this diff needs |
| `check [--no-app] [--coverage]` | merge gate: T0 + T1 + production build + real-Obsidian smoke. `--no-app` without a display |
| `change <file...\|pattern>` | the witness loop: one or more unit files, or a `-t` name pattern |
| `app [spec...] [--mobile] [--dogfood]` | real Obsidian, scripted turns; bare names resolve to `test/e2e/specs/<name>.e2e.ts` |
| `live [spec...]` | real model or MCP calls; local only |
| `eval [args]` | agentic evals; `--suite core` runs the tool-use suite (live) |
| `explore [args]` | chaos explore in a throwaway vault: leads, not proof |
| `release` | `check --no-app`, full app suite, mobile specs, scripted dogfood |

All run as `npm run verify -- <lane>`. Each run writes
`logs/verify/<ts>/summary.json` and `run-result.json`, prints a per-tier counts
line, and appends to `logs/history.jsonl`.

## What to run, by change

| Change | Commands | Proves |
|---|---|---|
| docs only | `check` (+ `npm run docs:build` for `docs/`) | links build, doc commands exist |
| test only | `change <test>`, then `check` | the new test runs; the suite is consistent |
| one module / logic bug | `change <test>` red then green, then `check` | the witness, then no regression |
| UI (command, panel, row, tab, mode) | `check` + `app <spec>` (+ `app --mobile`) | wiring and lifecycle in real Obsidian |
| agent, prompt, tool description | `check` + `app --dogfood` + `eval --suite core --runs 3` (live) | correctness, tool choice, cost vs the baseline |
| settings or persisted shape | `check` (upgrade fixtures are unit tests) + `app settings-ui` | save, reload, migration |
| provider or live path | `live <spec>` | the real API |
| `scripts/`, CI, gates | `change <script test>` + `check` | the gate still catches what it should |
| dependency or Obsidian upgrade | `check` + `app` (+ eval if the model path changed) | boot and behavior |
| big change (new tool, new UI entry point, prompt rewrite, 3+ merged PRs) | the above, then **propose** `explore` to the owner | leads for a human |
| release | `release` + `eval --suite core` + a real-device mobile smoke (manual) | the full picture |

No display here? Run `check --no-app` and let CI run the app jobs. On a desktop,
run headed lanes on a nested display: `npm run nested -- npm run verify -- app smoke`.

## Rules

1. Never merge unless the owner writes "merge".
2. Never claim done without the `logs/verify/<ts>/summary.json` path and its
   per-tier counts line.
3. Never go green by skipping. Zero tests or all skipped fails the lane. In T1
   and T2 the only allowed skip is `it.skip("flaky #<open issue>: <reason>", ...)`;
   `check` enforces it (`scripts/check-skips.mjs`).
4. Never call a model from CI. Live work is local, with a key and a display.
5. Never present scripted as live: every run result states `mode: scripted`,
   `live`, or `static`.
6. Never add a retry to a flaky test; fix the observation or the fixture.
7. Never use `no-behavior-change` for a behavior change or a deletion; a
   deletion uses the removal witness.
8. Every test file belongs to exactly one group in `test/manifest.json` (tier,
   triggers, needs, budget, command). An unlisted file fails `check`.

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

## Adding a test

1. Put it next to its peers and make sure a group in `test/manifest.json` matches
   it (`node scripts/check-test-manifest.mjs --list` shows the groups).
2. If no group fits, add one with a tier, triggers, needs, budget, command, and why.
3. Run `npm run verify -- plan --explain <test>` to see what it will trigger.
