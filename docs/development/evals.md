# Evals

Reference for agent-quality evals. Start with [testing.md](testing.md) for
when to run them. This page is for prompt, tool, context, model, or provider
changes, and for the eval harness itself.

## Names

One word, one thing (#393 T20):

| Name | What it is | Command |
|---|---|---|
| eval | the live tool-use runner: real model, real Obsidian, code-graded cases | `npm run verify -- eval [--canary \| --suite core \| --suite regression]` |
| canary | 5 sensitive `core` cases x 5 runs, for every prompt or tool change | `npm run verify -- eval --canary` |
| core | 12 cases that still move, 3 runs each; the committed baseline | `npm run verify -- eval --suite core --runs 3` |
| regression | 18 saturated or unique cases, 1 run, on demand | `npm run verify -- eval --suite regression` |
| scripted dogfood | real Obsidian, a generated vault, canned model turns; not an eval | `npm run verify -- app --dogfood` |
| static context | the default request's prompt phrases, tools, and budgets; a unit test | `test/static-context.test.ts` (in `check`) |

`npm run verify -- eval` with no arguments prints the `core` plan and spends
nothing. The LLM judge and the agentic A/B compare were deleted: they never ran.

## Tool-use evals

### The goal: three objectives, one Pareto frontier

The evals are a multi-objective harness, not a pass-rate harness. They measure
three objectives together:

| Objective | Metric | Better |
|---|---|---|
| Correctness | pass^3 (every run of a case passed), with mean pass@1 and partial score | higher |
| Cost | billed USD per run (what OpenRouter charged, not a price-table estimate) | lower |
| Time | median case wall time | lower |

The target is the Pareto frontier of that three-axis space, for the plugin
(prompts, tools, context, model, reasoning level) and for the harness itself
(a run must cost little and finish fast). A change is a win only when it
improves one axis and makes no other axis worse. A change that gains
correctness and costs more is a trade-off: name it and decide on purpose, do
not report it as a win. `--compare` prints this verdict under the overall
table: `dominates`, `dominated`, `trade-off`, `same`, or `incomplete`. A cost or
time change of at most 10% of the baseline counts as `same` (one sample moves
that much), with floors of $0.000001 and 100 ms for a tiny baseline. Use
`--significance` to see whether a correctness change is noise.

No cheating. These moves do not reach the frontier, they only move a number:

- weakening, deleting, or loosening a check so a case passes,
- editing a case only to raise or lower its pass rate (a case is fixed only
  when it is unfair: ambiguous, impossible, or graded on the wrong thing),
- changing the suite, the model, the reasoning level, or the vaults between
  the two sides of an A/B,
- cutting cost or time by skipping work the task needs (fewer runs, a smaller
  vault, a lower turn cap) and calling it a plugin gain,
- tuning the suite toward a target pass rate. A saturated case is a regression
  check, not a problem to fix with more full runs.

Keep the loop cheap: a smoke run (`--smoke`, 1 run per case) per change, a full
`core` x 3 run only for a model, prompt, tool, or context change and at most
once per PR.

The `tool-use` suite measures tool choice and the vault state that the model
leaves behind. Code grades the run; no judge model is used. Checks cover the
answer, the tool calls, the files, the frontmatter, and unchanged seed notes.

```bash
npm run eval:tool-use -- --env-file .env
npm run eval:tool-use -- --case read.answer-from-note --runs 2
npm run eval:tool-use -- --dry-run
npm run eval:tool-use -- --write-baseline
npm run eval:tool-use -- --compare logs/eval-runs/base/summary.json logs/eval-runs/head/summary.json
```

`--case` takes one id or a comma list. `--runs` overrides the run count in the
suite. `--compare` shows the overall metrics and a per-case table: pass rate,
pass^K, partial score, median time, mean tokens, mean USD, and flags.
`--write-baseline` writes `test/evals/baselines/<suite>.json` (`core` →
`core.json`) and includes the `overall` object plus the
per-case metrics. The runner refuses to write a baseline when a run was skipped
or had a harness error.

`npm run verify -- eval --suite <suite>` reaches the same runner for any suite
file in `test/evals/tool-use/`, by path or by bare name (`--suite core`).

The harness is split by job:

| File | Job |
|---|---|
| `scripts/run-tool-use-evals.ts` | CLI and I/O only: suite, plan, WDIO launch, output files |
| `scripts/eval/tool-use-core.ts` | suite validation, check grading, cost, budget, case and overall metrics |
| `scripts/eval/tool-use-plan.ts` | the runner/spec contract: `plan.json`, the run record, case selection |
| `scripts/eval/tool-use-report.ts` | summary, report, baseline, dry-run text |
| `scripts/eval/tool-use-compare.ts` | `--compare` |
| `test/e2e/evals/tool-use.eval.ts` | drives Obsidian and writes one run record per run; it never grades |

A run has one of four statuses. `pass` and `fail` are the model's result.
`error` is the harness's: the run gave no gradeable observation (a provider
error, a turn timeout, a missing run record). `skipped-budget` did not start.
An `error` run counts as executed and as not passed, but the report lists it
apart from failed checks, because it says nothing about the model. If the WDIO
spec dies half-way, the runner still writes `summary.json` and `report.md` for
the runs that finished, marks the rest as `error`, and exits non-zero.

For a quick before/after of a prompt or tool change, run the smoke slice:

```bash
npm run eval:tool-use -- --suite test/evals/tool-use/core.eval.json --smoke --runs 1 --env-file .env
```

`--smoke` runs the slice that the suite file itself names in its top-level
`smoke` list. For `core` that is 8 cases, one per category: `find.easy.today`,
`edit.easy.typo`, `organize.medium.inbox`, `create.hard.weekly`,
`properties.hard.owners`, `tools.easy.search`, `safety.medium.injection`, and
`recovery.medium.stale`. The validator rejects a `smoke` id that is not a case
in the suite, and `--smoke` fails for a suite with no `smoke` list
(`regression` has none). A run takes about 3 minutes and needs no baseline. Use
the full `core` suite (12 cases x 3 runs) for the committed baseline. `--smoke` cannot be
combined with `--case`, and it plans one run per case unless `--runs` is set.
`--dry-run` prints the 8 cases and needs no key.

The suite caps the cost with `maxUsd`, `maxModelCalls`, and `maxTokens`. Every
case with an `expected.maxToolCalls` also has a matching `max_tool_calls` check.
The suite names the model
(`deepseek/deepseek-v4.1-flash`). A run needs `AGENTIC_CHAT_API_KEY` and a
display. It runs locally only; CI does not run it.

The live calls pin the model, the temperature, and the reasoning level:
`deepseek/deepseek-v4.1-flash`, temperature 0, and the level the suite names. The
`core` and `tool-use` suites pin `low`, so a new measurement is explicit. The
older `tool-use` baseline predates the axis and has no `thinkingLevel` field; do
not compare it as if it named one. The product default is `off`; a user can pick
any supported level. A tool or prompt comparison must hold the level fixed.

Reasoning is a first-class axis:

| source | how to set it |
|---|---|
| CLI | `--thinking-level <level>` |
| environment | `AGENTIC_CHAT_THINKING_LEVEL=<level>` |
| suite | `"thinkingLevel": "low"` |
| default | `low` when no source sets one (the runner default) |

Precedence is CLI > env > suite field > `low`. A per-case `thinkingLevel` pins
that case and wins over the run-level value. Allowed levels are `off`,
`minimal`, `low`, `medium`, `high`, and `xhigh`; an unknown value fails before
the run and names the source.

`off` sends no reasoning parameter; the provider then decides. Do not read it as
a fixed baseline. The catalog for `deepseek-v4.1-flash` reports a default effort
of `high`, and a direct unpinned request did reason; the eval route, by contrast,
recorded 0 reasoning tokens in all 330 assistant messages of the `off` baseline.
Routing can change it. The `core` suite pins `low` so the number in the baseline
means what its label says; the product default stays `off`.

The plan, summary, report, baseline, and dry run record the effective level. A
per-case pin is resolved before the plan is written, so `plan.json` has one
`thinkingLevel` per case. The e2e spec sets `settings.thinkingLevel` from the
plan and restores it for the next case. It also reads the last
`thinking_level_change` entry from the run's session and writes
`observedThinkingLevel` into the result JSON. A mismatch is reported in the
summary (`observedThinkingLevels`, `thinkingLevelMismatches`), never fails a
run: a provider clamp is data, not a harness error.

A dry run prints the run level and the effective level of every case:

```text
Thinking level: low (suite)
- find.hard.venue: 1 run(s), 516 seed file(s), thinking low
```

### Reasoning level A/B on the smoke slice

The eight-case smoke slice ran once per level with everything else pinned. The
same suite revision, model, temperature, and vaults were used. Every run
observed the level it requested; the summaries report 0 mismatches. Reproduce
one level with:

```bash
npm run eval:tool-use -- --suite test/evals/tool-use/core.eval.json --smoke \
  --runs 1 --thinking-level <level> --env-file .env --run-id ab-smoke-<level>
```

| Level | Observed | Pass | Cost | Mean tokens | Median case | Notes |
|---|---|---|---|---|---|---|
| `off` | `off` | 4/8 (50%) | $0.003305 ($0.000413/run) | 23,761 | 5.2s | 0 reasoning tokens on the eval route; another route can default high |
| `low` | `low` | 8/8 (100%) | $0.004689 ($0.000586/run) | 30,927 | 11.2s | run pinned with `--thinking-level low`; +42% cost over `off` |
| `high` | `high` | 6/8 (75%) | $0.014343 ($0.001793/run) | 97,208 | 19.0s | 3.1x the `low` cost |

The full 75-run `core` baseline at `low` is 76% pass^3 (19 of 25 cases), 83%
mean pass@1, $0.0354 total, and 34,065 tokens per run. The earlier `off`
baseline was 76% pass^3 (19 of 25), 84% mean pass@1, $0.0215, and 24,532
tokens per run. Two caveats stop a simple ranking: that `off` pass predates the
localhost fixture fix (`tools.medium.web` was 0/3 there and 3/3 at `low`), and
one run per case on the smoke slice is directional, not a significance test. On
the 24 cases both runs cover, `off` still won more cases.

The product default stays `off`. The full 75-run baseline equalizes pass^3 and
favors `off` on mean pass@1 and cost, and one run per smoke case is too small to
overrule it. `off` is still not
a fixed control: the catalog says `high`, a direct request reasoned, and the eval
route recorded 0 reasoning tokens, so routing can move it. The eval suite keeps
pinning `low` so the axis is exercised and every run names its level. Revisit the
product default after the significance layer (bootstrap CI) and a second `low`
baseline; do not move it based on one run.

The eval vault sets `alwaysUpdateLinks: true`, so a rename updates links without
a prompt. `seed.files` writes text notes. `seed.binaryFiles` writes base64 bytes,
for example a PDF. The `unchanged` check covers text seeds only. `file_exists`
and `file_absent` see every file in the vault, so a moved PDF or CSV is
gradeable; the content checks read Markdown only.

### The `core` suite and generated vaults

`core` is the default live tier for prompt, tool, and model comparisons: 12
cases that still move (#393 T20). Eight were below pass^3 in the last three
27-case baselines (`find.easy.dentist`, `find.easy.today`,
`organize.easy.invoice`, `organize.hard.atlas`, `create.hard.weekly`,
`properties.hard.owners`, `tools.easy.search`, `tools.medium.mcp`); the canary
anchors `edit.easy.typo`, `organize.medium.inbox`, `safety.medium.injection`
and `recovery.medium.stale` complete it. `runsPerCase: 3`; pass^3 is the
headline. The 14 saturated cases and the 4 tool-use cases `core` does not cover
are `regression.eval.json` (1 run, on demand). `safety.hard.ambiguous` is now a
replay test (`test/ask-before-delete.test.ts`).

The committed baseline is `test/evals/baselines/core.json`, measured on
2026-11-18 at `73445b1` with 36 runs (12 x 3) on `deepseek/deepseek-v4.1-flash`
(`thinkingLevel: low`), `--parallel 2`, cost billed by the provider:

| Axis | Value |
|---|---|
| Correctness | 92% pass^3 (11 of 12), 94% mean pass@1 |
| Cost | $0.066 billed in total, $0.0018 per run, 41,384 tokens per run |
| Time | 7.5 s median case; 7 min 05 s wall with 2 instances (longest shard 6:51) |

Wall time: the same 36 runs at `--parallel 1` took 12 min 09 s of spec time
($0.073); with 2 instances 6 min 40 s to 7 min 05 s. The two slow hard cases
(`organize.hard.atlas` about 45 s, `properties.hard.owners` 33-90 s per run) set
the floor: shards weigh each case by its baseline median time, but run-to-run
variance on those two still leaves one shard about twice as long as the other.

Upstream 429s ("temporarily rate-limited" from OpenRouter) hit 4 of about 150
runs on 2026-11-18. The runner records them as harness errors and refuses to
write a baseline from such a run; rerun it.

Do not rank this baseline against an older one on cost: the older baselines are
priced from a stale price table (about a third of the billed price), so
`--compare` marks the cost axis as not compared. Compare correctness and time
only, or rerun the older side.

Saturation rule: a case that reaches pass^3 in three baselines in a row moves to
the `regression` tier, and `core` gets a harder variant of it. A case
that stays at 0 across three baselines is a case bug, not a hard case; check the
grader before the next baseline. Live runs are local only; CI has no model key.

A case can ask for a seeded synthetic vault instead of a hand-written seed:

```json
"seed": { "vault": { "size": "M", "seed": 7 }, "files": {} }
```

`size` is `S` (50 notes), `M` (500 notes), or `L` (2,000 notes); `seed` is a
non-negative integer. `scripts/eval/vault-generator.ts` builds the notes with a
seeded PRNG, so the same pair always produces the same bytes. Case `seed.files`
entries are merged over the generated base, so a case can add or replace needles.
The runner writes the expanded map into `plan.json`; the spec still reads
`seed.files`.

`L` is for a small hard slice, not the default: it costs more to seed and more
tokens to search. At that size the topic/kind/language pairs repeat, so repeated
names take a stable number (`Atlas Launch - Overview 2`). Every basename stays
unique, so a wikilink always resolves to one note. `S` and `M` keep the bytes
they had before `L` existed; `core.eval.json` still seeds `S` and `M` only.

`summary.json` has an `overall` object: `passAllK` (share of cases where every
run passed), `meanPassAt1`, `partialScore`, `totalUsd`, `meanUsd`, `meanTokens`,
`meanModelCalls`, `meanToolCalls`, and `medianCaseMs`. Cost is what OpenRouter
billed: the spec sums `usage.cost.total` from every assistant message with
`totalFromProvider: true` into the run's `usage.billedUsd`. Only when a run has
no billed cost does the price table times tokens apply; each run records
`usdSource` (`billed` or `table`), and the report prints a `Cost source` line.
The summary and the baseline carry `costSource` (`billed`, `table`, `mixed`, or
`none` when no run spent anything). `--compare` ranks cost only when both sides
are `billed` or both are `table`; otherwise it warns, hides the per-case `cost`
flag, and the Pareto verdict is `incomplete`.
The table alone was about 45% too low on 2026-11-16 (reasoning tokens and
per-provider prices), so do not compare a table number with a billed one. Each case also reports
`passAllK`, `partialScore`, `medianMs`, and `overBudgetRuns` (runs above
`expected.maxToolCalls`; a reporting budget, not a check). `report.md` and the
console print the same numbers.

`--compare` prints the overall rows and a `Flags` column per case: `cost +N%` or
`time +N%` when a value grows more than 20% over the baseline, and `pass -N`
(percentage points) when the pass rate drops. A case on one side only is flagged
`new case` or `removed case`, and a value that one side lacks reads `(missing)`,
never 0. The output starts with each run's suite, model, and thinking level, and
a warning line appears when the two files name a different suite or model; the
case table has a `Thinking` column with the requested and observed levels. It is
read-only: it exits 0 after printing the table. A missing or unreadable summary
file still fails.

### Significance

A 25-case suite cannot separate a few points from noise. `--significance` adds a
case-level paired bootstrap after the comparison table. The cases, not the runs,
are the resampling unit: it draws the paired cases with replacement 2,000
times, with seed 12345, and takes the mean `passAllK` and `passRate` difference
(candidate - baseline). The 95% CI is the 2.5% and 97.5% percentile bounds. The
verdict is `significant` only when that interval excludes 0.

```bash
npm run eval:significance -- <base-summary.json> <head-summary.json>
npm run eval:tool-use -- --compare <base-summary.json> <head-summary.json> --significance
```

`--exclude <id[,id]>` drops a case from the significance read only, for a case
with a known harness fault. The comparison table above it still lists that case,
and the section prints `Excluded: ...`. An unknown id prints a warning on stderr
and exits nonzero; both tables still print. A case with a missing or non-finite
score is skipped and named in the `Warnings` line, not dropped without a trace.
Both an old baseline without `runResults` and a fresh `summary.json` work; only
the per-case `passAllK` and `passRate` fields are read. An old baseline without
`passRate` falls back to `passAllK` and labels the row. If no case has a
usable `passAllK` on both sides, the command prints the empty section and exits
1, as an old baseline without `passAllK` does.

The interval covers the choice of cases, not run-to-run variance, and 25 cases
make it wide. `not significant` means this suite cannot separate the change from
noise; it does not prove the change does nothing. `significant` is still local
to this suite, model, and level.

Low vs off on the 25-case `core` baselines (`61cab74` off, `e002d98` low):
76% -> 68% pass^K, difference -8 pp, 95% CI [-32, +16] pp, not significant.
`tools.medium.web` is 0/3 in the off baseline because the provider rewrote the
fixture URL to `[IP_ADDRESS]`; excluding it gives 79.2% -> 66.7%, -12.5 pp,
CI [-33.3, +8.3] pp, still not significant. The honest conclusion is that the
8-point pass^3 gap sits inside the noise band of a 25-case suite. Do not call
`low` worse, or `off` better, from this pair alone.

Live runs need `AGENTIC_CHAT_API_KEY` and a display. They run locally only; CI
does not run them.

### The A/B loop: canary, eval:ab, explain, baselines

```bash
npm run eval:tool-use -- --suite core --canary [--parallel 2] --env-file .env
npm run eval:ab -- --case organize.easy.invoice,tools.easy.search --runs 5 --env-file .env
npm run eval:explain -- logs/eval-runs/<run id>          # first failed run, one page
npm run eval:explain -- --saturation core               # cases at pass^k in the last 3 baselines
npm run eval:tool-use -- --write-baseline-from logs/eval-runs/<run id>/summary.json
```

- `--canary` runs the suite's `canary` slice (5 cases) 5 times each. Each case
  gets a 95% Wilson interval. A case moved ("drop" or "gain") only when its
  baseline pass rate is outside the interval; otherwise it is noise. The
  verdict is `Signal` for a strong move (60 points or more from the baseline)
  or two cases moving the same way; one weak move is `Weak: run it once more`.
  Two canary runs on an unchanged `main` (2026-11-18) each had one weak drop
  (`tools.easy.search` 4/5 and 3/5 against a 3/3 baseline), which is why one
  case alone is not a signal. Those runs: $0.027 and $0.028, 4 min 52 s and
  5 min 24 s of spec time; `organize.easy.invoice` was 4/5 and 3/5, so it stays
  in the canary.
- `--parallel N` runs N Obsidian instances side by side, each with its own
  vault and driver port, after one e2e build. All runs of a case stay on one
  instance; the instances share one budget (every record in the run's results
  folder counts). The summary and baseline record `parallel: N`, and
  `--compare` warns when the two sides used a different N (time axis only).
- `eval:ab` runs the cases on `--base` (default `origin/main`) in a temporary
  detached worktree, then on the current tree, and prints one table. With 2 or
  more cases it adds the paired bootstrap. `--dry-run` prints the plan only.
  `--max-usd` caps each side.
- `--compare` marks a pass drop at fewer than 5 runs as `(n=3, check with
  eval:ab)` and prints the `eval:ab` command for those cases.
- `--significance` also prints total cost (billed on both sides only) and median
  case time, with the same bootstrap.
- `eval:explain` shows the prompt, each tool call with its arguments (from
  `results/<case>/<run>.session.jsonl`), the answer, and the check evidence.
  `--regrade <run dir> [--suite <path>]` grades the saved records of a past run
  again with the current checks (no model call) and lists each run whose
  status changed: the way to prove a check fix on runs that already happened.
- Every baseline write also appends `test/evals/baselines/<suite>/<time>-<head>.json`.
  The saturation flag reads that history. `--write-baseline-from` writes a
  baseline from a finished run with no model call and the same refusal rules.
- A dead harness (`invalid session id`, lost window) stops the run at once; the
  rest of the plan is recorded as `harness died`. The runner blocks sleep with
  `systemd-inhibit` when it exists.

### Local fixture server for web cases

`scripts/eval/fixture-server.ts` is a local HTTP server for `fetch_url` eval
cases. It binds the IPv6 wildcard (`::`), which is dual-stack, so the client can
reach it over `::1` or `127.0.0.1`, and it advertises
`http://localhost:<port>`. It uses an OS-assigned port by default, so cases stay
deterministic and offline:

```bash
npm run fixture:serve -- --json
npm run fixture:serve -- --port 8080 --slow-ms 500
```

The endpoints cover the cases a web tool must handle: `/article` and
`/article-v2` (different dates), `/redirect`, `/429` with `Retry-After`,
`/slow`, `/json`, `/not-found`, and `/echo?q=...` for prompt-injection
payloads. `--slow-ms` sets the `/slow` delay.

The runner starts the server only when a selected case needs it: a prompt with
`{{fixture}}`, or a case that sets `"web.enabled": true`. It writes
`fixtureBaseUrl` into `plan.json`, replaces every `{{fixture}}` in the prompt,
and closes the server in a `finally` block. `--dry-run` and `--compare` start
no server; a dry run marks such a case with `, fixture server` in its plan. A
prompt that uses `{{fixture}}` with no base URL fails before the e2e starts. The
`core` suite has one such case, `tools.medium.web`: it sets `web.enabled: true`
and uses `{{fixture}}`, and the runner allows its one exact origin. Every other
core case starts no server.

The eval spec sets the `__AGENTIC_CHAT_EVAL_FIXTURE_ORIGIN__` window global to
that base URL's origin in the Obsidian window. `normalizeWebUrl` allows one
exact match and nothing else: every other loopback, private, or different-port
address stays blocked. Only the e2e build reads the global. It sits behind the
same build flag as the replay stream (`__AGENTIC_CHAT_ENABLE_E2E_STREAM__`), so
a release bundle contains no such code and no window global can relax the SSRF
gate there. `scripts/verify-mobile-compat.mjs` fails a release bundle that still
contains the hook name.

A web case has this shape:

```json
{
  "id": "web.medium.article",
  "prompt": "Fetch {{fixture}}/article and report its published date.",
  "seed": { "files": {} },
  "settings": { "web.enabled": true },
  "checks": [{ "type": "answer_contains", "text": "2026-01-05" }]
}
```

`web.enabled` is false in the base eval config, so a case must opt in. The fake
MCP server (about 30 tools for P12 `search_tools`) opts in the same way; see the
next section.

`tools.medium.web` is the live case. It passes 3/3 in the 2026-11-15 baseline:
the model calls `fetch_url` with the fixture URL and answers with the published
date. The fixture server advertises `localhost` because the pinned model's
provider rewrites a literal `127.0.0.1` to `[IP_ADDRESS]` in tool arguments,
which makes such a URL invalid before it reaches the server.

### Local fake MCP server for tool-search cases

`scripts/eval/fixture-mcp-server.ts` is a local Streamable HTTP MCP server with
30 tools. It exists for a future P12 `search_tools` case where the model must
find one MCP tool among 30 realistic candidates. It uses no external network.

```bash
npm run fixture:mcp -- --json
npm run fixture:mcp -- --port 0 --tools 30
```

It uses the same dual-stack listener as the HTTP fixture and advertises
`http://localhost:<port>`. The printed `url` is the MCP endpoint
(`http://localhost:<port>/mcp`), so it can go straight into an MCP server
setting. `--tools` sets the number of listed tools.

`POST /mcp` speaks JSON-RPC 2.0 and answers JSON, not SSE. It handles
`initialize` (a supported protocol version, `capabilities.tools`, `serverInfo`,
and an `Mcp-Session-Id` header), `notifications/initialized` (202, no body),
`ping`, `tools/list`, and `tools/call`. The protocol version is `2025-11-25`,
with `2025-06-18` and `2024-11-05` as explicit fallbacks; an unknown value gets
`2025-11-25`, never an echo. A few tools return fixed records; the rest echo
their arguments, so every call is deterministic. An unknown tool returns a
JSON-RPC `-32602` error. `GET /mcp` returns 405 because the server never asks
the client to open an SSE stream.

The tools cover search, documents, tickets, calendar, files, and admin.
`test/fixture-mcp-server.test.ts` checks the raw protocol and one handshake,
listing, and call through `McpHttpClient`. Both fixture servers share
`scripts/eval/fixture-http.ts` for the listener, response, and CLI lifecycle.

#### Wiring a case to the fake MCP server

A case opts in with the same dotted-settings mechanism as a web case:

```json
{
  "id": "tools.medium.search",
  "prompt": "Find the tool that reads a support ticket and read ticket T-42.",
  "seed": { "files": {} },
  "settings": { "mcp.enabled": true },
  "checks": [{ "type": "answer_contains", "text": "T-42" }]
}
```

`needsMcpFixture` in `scripts/eval/tool-use-plan.ts` is true only for a selected
case with `"mcp.enabled": true`. The runner starts the server only when such a
case is selected, writes its endpoint as the optional `mcpFixtureUrl` field in
`plan.json`, and closes it in the `finally` block next to the web fixture. No
case needs it: no server starts and the plan has no `mcpFixtureUrl` field. A dry
run starts no server and marks the case with `, fake MCP server`.

The eval spec reads `mcpFixtureUrl` and configures `settings.mcp.servers` with
exactly one user-owned server at that URL (id `eval_fixture`, `authType` `none`,
`approval` `allow`). The base config keeps `mcp.enabled` false, so the case's own
`"mcp.enabled": true` turns MCP on for its runs only; the existing per-case
restore puts the base value back before the next run.

The MCP endpoint policy (`mcpUrlProblem` in `src/utils/host-policy.ts`) allows
plain http for loopback hosts, so the fixture needs no eval-only SSRF hook. This
differs from `fetch_url`, whose gate blocks every loopback address unless the
spec installs `__AGENTIC_CHAT_EVAL_FIXTURE_ORIGIN__`. The fixture advertises
`localhost`, which the policy treats as loopback.


## Deterministic replay

Promote live dogfood bugs into fast replay coverage when the rough edge is plugin
behavior, not provider planning quality. `test/helpers/agent-replay.ts` scripts
assistant turns, exercises the real `AgentService` tool gates, persists session
JSONL, and asserts the final transcript or vault/session evidence. Feed the JSONL
through `scripts/analyze-session-trace.mjs` when the finding is about
observability or tool efficiency.

## Trace mining

```bash
npm run analyze:session -- logs/dogfood-runs/<run-id>/vault/.obsidian/plugins/agentic-chat/sessions
npm run analyze:session -- <sessions-dir> --format markdown
npm run analyze:session -- --compare <before-dir> <after-dir> --format markdown
```

Markdown output is for human triage and highlights token use, cache hits, active
note context, duplicate tool calls, approval denials, and tool errors.

`npm run trace:mine -- --sessions <sessions-dir>` writes anonymized
`candidates.json` and `report.md` under `logs/trace-mining/<timestamp>/`. To turn
one candidate into a draft case:

```bash
npm run trace:mine -- --sessions <sessions-dir>
npm run eval:from-trace -- --candidate logs/trace-mining/<timestamp>/candidates.json --id <candidate-id>
```

The converter writes `logs/eval-candidates/<timestamp>/<id>/case.draft.json` and
`README.md` from the redacted candidate only. It never reads a session file and
never calls a model. `--out <dir>` changes the base directory.

Then fill the TODOs in the draft: choose or capture the vault, restore the exact
prompt, write code-gradeable checks, and replay on current `main` with a live
model. Add the case to `core` only if the replay fails and the checks are fair. A
draft has `checks: []`, so it is not a suite case and must not be committed as
one.

