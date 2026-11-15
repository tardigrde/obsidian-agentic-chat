# Verification

One entry point, several lanes. Pick the lowest lane that can actually fail for the
risk you introduced. Do not invent a lane per task.

```bash
npm run verify -- fast                 # merge gate
npm run verify -- ci                   # what CI runs
npm run verify -- smoke                # production bundle + no-key smoke e2e
npm run verify -- change <target>      # one unit file, or a -t pattern
npm run verify -- e2e [spec]           # e2e bundle + one spec (or all)
npm run verify -- dogfood              # generated-vault dogfood
npm run verify -- eval [args]          # agentic evals
npm run verify -- audit [mode]         # design audit: sidebar|wide|mobile|fullscreen
npm run verify -- all                  # everything above
```

`npm run verify:fast` is an alias for `fast`. Each run writes
`logs/verify/<timestamp>/` with one log per step, `summary.json`, and
`summary.md`, and prints one pass/fail table.

## The ladder

| tier | command | use when | cost |
|---|---|---|---|
| L0 | `npm run verify -- change test/foo.test.ts` | pure logic, one module | seconds |
| L0 | `npm run verify -- change "test name"` | one behavior by name | seconds |
| L1 | `npm run verify -- change test/a.test.ts` (repeat) | a few affected modules | seconds |
| L2 | `npm run verify -- ci` | app/e2e/scripts types, lint, unit + coverage report, bundle | ~1 min |
| L2 | `npm run verify -- upgrade` | persisted settings or session shape changes | seconds |
| L2 | `npm run verify -- cloud` | cloud sandbox without a display: everything but e2e | ~1 min |
| L3 | `npm run verify -- fast` | merge gate, includes smoke e2e | ~2 min |
| L4 | `npm run verify -- e2e <spec>` | UI wiring, view lifecycle, settings migration | ~1 min |
| L5 | `npm run verify -- dogfood` | multi-tool agent flows in a generated vault | minutes |
| L6 | `npm run verify -- eval` | prompt, tool, context, or provider changes | minutes |

L4 and the eval/dogfood lanes open real Obsidian windows. On a desktop, every
window asks the window manager to activate it and steals the cursor. Run them on
a nested Xephyr display:

```bash
npm run nested -- npm run verify -- e2e test/e2e/specs/smoke.e2e.ts
npm run nested -- npm run eval:tool-use -- --suite test/evals/tool-use/core.eval.json --runs 3 --env-file .env
```

`npm run nested` starts Xephyr on a free display and stops it when the command
exits. It is a real GUI Obsidian, not `AGENTIC_CHAT_E2E_HEADLESS=1` (headless has
no accessibility tree). Use `--display :N` to reuse a running Xephyr and
`--screen WxH` to change its size. Probes and the chaos runner already own their
display.

For agent-quality changes, compare two eval runs instead of reading one:

```bash
npm run verify -- eval --run-id baseline --dogfood-run-id <run-id>
# apply the change
npm run verify -- eval --run-id candidate --dogfood-run-id <same-or-new-run-id>
npm run eval:agentic:compare -- \
  logs/eval-runs/baseline/summary.json \
  logs/eval-runs/candidate/summary.json \
  --out logs/eval-runs/candidate/ab-comparison.md \
  --fail-on-regression
```

The `eval` lane adds `--fail-on-skip`, so a skipped case fails the run. Pass
`--run-scripted` to generate the dogfood artifact instead of skipping it; that
path needs Obsidian. A leading bare `--` is tolerated, but it is not needed.

### Upgrade lane

`test/fixtures/releases/<version>/` holds the `data.json`, `secrets.json`
(fake values), and session JSONL that a released version wrote.
`test/upgrade-fixtures.test.ts` loads each one through HEAD's load path:
secret migration, retired-setting notices, `mergeSettings`, secret hydration, a
second load after save, and a session replay. It runs in the unit suite.

After each release, capture its fixtures and commit them:

```bash
npm run capture:release-fixtures -- <version>
```

The script checks out the tag in a temporary worktree and runs
`scripts/release-fixtures/capture.spec.ts` with that release's own code. It
stages the output and swaps it in only when `data.json` and a session exist, so
a failed run keeps the committed fixture. It uses this checkout's
`node_modules`, so very old tags (before the secret store) cannot be captured.

### Cloud lane

A cloud sandbox cannot start Obsidian, so it cannot run e2e, probes, or chaos.
Run `npm run verify -- cloud` there. Do not make a UI claim (rendering, layout,
a settings row, a click path) from a cloud run. Say which claim needs a CI
`e2e` run or a local e2e/probe, and leave it for that run.

### Multi-instance harness

Every chat tab and window builds its own service over shared state (the session
folder). `test/helpers/interleave.ts` wraps an
adapter so each call yields a seeded number of macrotask turns; a scenario runs
two instances with `Promise.all` under many seeds and asserts invariants that
must hold for every ordering. See `test/session-multi-instance.test.ts`. A
failing seed replays exactly. Use it for any change to state that two tabs
share.

## What a pass has to show

- The command, its exit code, and its test counts.
- A witness for the change: the smallest check that fails before and passes after.
  For a bug, run it before the fix and paste both results.
- For UI claims, either a committed e2e assertion or a probe recording plus DOM or
  state metrics. A screenshot or a video alone is not a verdict.
- For a changed user-visible entry point, desktop `1280x1024` and mobile-width
  `390x844` clips, each with a “what to watch” list. The `390x844` clip is a
  narrow desktop window, not real Obsidian Mobile. A removal also needs absence
  proof; use `@break-change` removal mode. If clips are impossible, put a waiver
  in the PR.
- The artifact path when the lane writes one.

Zero tests, or every test skipped, is a failure. `verify` fails a lane that expects
tests when it can prove nothing ran, and the eval lane passes `--fail-on-skip` by
default. If a lane cannot execute because credentials are missing, say so and run
a lane that can.

## Live MCP

The live MCP spec defaults to Context7's `resolve-library-id` tool and makes a
real HTTPS call:

```bash
AGENTIC_CHAT_E2E_MCP_URL=https://mcp.context7.com/mcp npm run verify -- e2e test/e2e/specs/mcp-live.e2e.ts
```

The spec skips when `AGENTIC_CHAT_E2E_MCP_URL` is unset, so a zero-test exit is
not a pass. Read the passing count.

## Witness

`npm run verify:witness` reverts the source diff, runs the test, restores the
fix, and runs the test again. The verdict is `PASS` only when the red run
failed on an assertion and the green run passed:

```bash
npm run verify:witness -- \
  --base origin/main \
  --test-file test/agent-conversation.test.ts \
  --src src/agent/conversation.ts
```

A non-zero exit alone is not proof. The verifier rejects loader, parser, and
compiler output (`SyntaxError`, `Cannot find module`, `error TS####`, and
similar) with "red run did not reach an assertion", and it requires a parsed
failed-test count such as `Tests 1 failed` or `1 failing`. Run
`npm run verify:witness -- --self-test` to prove the verifier itself.

The `Witness` workflow always runs that self-test. It also runs the block in the
PR body when the PR changes `src/` or has the `behavior` or `witness` label. A
pure refactor can use the `no-behavior-change` label instead. CI supplies the
base commit; the PR supplies one test file and one or more source paths.

```markdown
<!-- witness
test: test/agent-conversation.test.ts
src: src/agent/conversation.ts
-->
```

The independent verifier protocol and the explicit-merge rule live in
[trust.md](trust.md).

## Fake green

Check the observation method before trusting the result:

- **Stale bundle.** `main.js` is gitignored but drives every local run. Did the
  lane rebuild it? `fast` and `smoke` run a production bundle first.
- **Silent skip.** Live specs skip when `AGENTIC_CHAT_API_KEY` is empty. An exit
  code of 0 with zero passing tests proves nothing. Read the counts.
- **Wrong vault.** Dogfood and probes use generated vaults. Check the run id in
  the artifact path.
- **Cached plugin state.** Disable and re-enable, or verify the plugin version in
  the UI before asserting.
- **Existence instead of content.** `toExist()` on a container does not prove the
  feature rendered. Assert text or layout.
- **Mocking the subject.** A unit test whose mock implements the behavior under
  test cannot catch a regression.
- **Proxy noise.** `ERR_NO_SUPPORTED_PROXIES` means Obsidian died before the
  feature ran. See the proxy notes in `AGENTS.md`.
- **Scripted recording.** A probe can run against scripted turns or a real model.
  The report states `mode: live` or `mode: scripted`. Never present scripted as
  live.

## Probes

Use a probe when you do not yet know what correct looks like, or when a human needs
to see the behavior. A probe is a scenario, not a test:

```bash
npm run probe -- --scenario settings-gate
npm run probe -- --scenario live-chat --live
npm run probe -- --scenario layout-smoke
```

It starts an isolated Xvfb display, records the whole display with ffmpeg (so
Obsidian popouts and settings are in frame), drives a throwaway vault, and writes:

```text
logs/probes/<timestamp>-<scenario>/
  session.mp4
  session-raw.mp4 (only when the black lead-in was trimmed)
  key.gif (only with --gif)
  timeline.json
  metrics.json
  shots/*.png
  report.md
```

The recording is evidence for a human. The assertions extracted from a probe are
what enter `verify`. See `@probe-feature` for the protocol.

## Break-change

Use `@break-change` before a product-cut PR, when a command or UI entrypoint is
deleted, or when you need a small adversarial sweep of the feature map. It is not
a verify lane and not a gate. It reads the work item, picks 5-10 risky scenarios,
drives the real Obsidian e2e harness on a throwaway vault, and writes:

```text
logs/break-change/<timestamp>/
  report.md       PASS | FINDINGS | INCONCLUSIVE, with severity and repro
  events.jsonl    one event per scenario and audit step
  run.log         exact e2e output and counts
  audit.json      removal-audit surface matrix
  scan.json       feature-map partial/NONE candidates
  clips/          optional desktop and mobile UI recordings
```

```bash
node .agents/skills/break-change/scripts/break-change.mjs init \
  --work-item "PR #123: remove /endplan" --mode removal --pr 123
node .agents/skills/break-change/scripts/break-change.mjs run \
  --run logs/break-change/<timestamp>
node .agents/skills/break-change/scripts/break-change.mjs report \
  --run logs/break-change/<timestamp>
```

Removal mode proves the entrypoint is absent from `/help`, the command registry,
the UI, docs, the slash-command table, the feature map, imports, and routes. It
also proves adjacent surviving behavior still works. General mode scans the
feature map for `partial` and `NONE` rows and targets a small high-risk subset.

A break-change report is exploratory evidence. It does not replace `/doctor`,
e2e, or the witness. Promote a confirmed finding into a deterministic test or
replay before you treat it as covered.

## Chaos monkey

Use `@chaos-monkey` after several PRs ship, when you want exploratory breadth
instead of a focused change gate. It creates a seeded throwaway vault, installs
the built plugin, launches real Obsidian on an isolated display, and drives the
committed in-app driver through real UI actions and, with `--live`, real model
calls.

```bash
npm run chaos -- --mode focused --target settings          # capped dry run
npm run chaos -- --mode generic --max-steps 6              # dry exploration
npm run chaos -- --mode focused --target composer --live \
  --max-steps 2 --max-seconds 180 --max-calls 2 --max-tokens 4000
```

Focused targets are `composer`, `settings`, `notes`, `mcp`,
`retired-commands`, `steer`, `queue`, `stop-send`, `max-turns`,
`settings-persistence`, `approval-paths`, `session-reload`, `large-input`, and
`mcp-lifecycle`. Generic mode chooses from the same actions with a seeded choice
stream, one slot per action, so note writes no longer dominate. Without `--live`
and an API key the runner stays in a capped dry run that cannot spend tokens.

An action reserves its full model-call estimate before it runs. When the
estimate does not fit the remaining `--max-calls`, the driver records a
`skipped` step with the needed and remaining calls and continues with the next
action. It stops with `max-calls` only when nothing left fits or the cap is
reached. A focused `max-turns` dry run reserves 25 calls, so pass
`--max-calls 25` unless a smaller cap should skip it.

It writes:

```text
logs/chaos/<timestamp>/
  report.md          verdict, caps, steps, findings, safety, artifacts
  session.mp4        whole-display recording
  shots/             screenshots and keyframes
  action-log.jsonl   one line per action
  driver-result.json machine-readable result
  plan.json          mode, target, caps, model (no secrets)
  sessions/          copied session JSONL when available
```

The vault is always a fresh `<temp>/chaos-monkey-*` directory with a seed
marker. The runner does not accept a vault path. Hard caps cover steps, wall
time, model calls, and estimated tokens; `touch logs/chaos/<timestamp>/CANCEL`
is the kill switch. A chaos report is exploratory evidence and never replaces
the witness, `fast`, or a committed e2e assertion.

`--charter eval-mining` is the first experiment for the data engine. It asks one
explore run to act like a vault owner with a single realistic goal over 2-8 chat
turns, so the run leaves a session trace under `sessions/`. `npm run
analyze:session` summarizes it today. `npm run trace:mine` turns the trace into
anonymized candidates, and `npm run eval:from-trace` turns one candidate into a
draft case for human review. Neither writes a final eval case by itself, and
neither replaces the core suite.

## Promotion

Every verification gap that caused a real problem becomes structure, not prose:

| finding | promotion |
|---|---|
| Bug seen in a live run | deterministic replay in `test/helpers/agent-replay.ts` |
| New user entry point | feature map entry plus an e2e assertion |
| Rule violated twice | lint rule, script check, or CI gate |
| Layout regression | `test/e2e/support/layout.ts` assertion |
| Flaky spec | fix the observation or the fixture; do not retry |

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
never calls a model. `--out <dir>` changes the base directory. `--sessions <dir>`
is accepted for a future session lookup and is not read in v1.

Then fill the TODOs in the draft: choose or capture the vault, restore the exact
prompt, write code-gradeable checks, and replay on current `main` with a live
model. Add the case to `core` only if the replay fails and the checks are fair. A
draft has `checks: []`, so it is not a suite case and must not be committed as
one.

## Tool-use evals

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
`--write-baseline` writes `test/evals/baselines/<suite>.json` (`tool-use` →
`tool-use.json`, `core` → `core.json`) and includes the `overall` object plus the
new per-case metrics. Do not write a baseline when a run was skipped or had a
harness error.

For a quick before/after of a prompt or tool change, run the smoke slice:

```bash
npm run eval:tool-use -- --suite test/evals/tool-use/core.eval.json --smoke --runs 1 --env-file .env
```

`--smoke` runs 8 `core` cases, one per category, once each: `find.hard.venue`,
`edit.hard.status`, `organize.medium.inbox`, `create.medium.summary`,
`properties.hard.owners`, `tools.easy.search`, `safety.medium.injection`, and
`recovery.medium.stale`. A run takes about 3-5 minutes and needs no baseline. Use
the full `core` suite (24 cases x 3 runs) for the committed baseline. `--smoke`
cannot be combined with `--case`, and it plans one run per case unless `--runs`
is set. `--dry-run` prints the 8 cases and needs no key.


The suite caps the cost with `maxUsd`, `maxModelCalls`, and `maxTokens`. Each
case also has a `max_tool_calls` check. The suite names the model
(`deepseek/deepseek-v4.1-flash`). A run needs `AGENTIC_CHAT_API_KEY` and a
display. It runs locally only; CI does not run it.

The live calls pin the model and the reasoning level:
`deepseek/deepseek-v4.1-flash`, `thinkingLevel: off`, temperature 0. A tool or
prompt comparison must hold those fixed. A reasoning-level A/B is future work:
add a `thinkingLevel` axis to the runner (suite default plus a per-case override)
and record it in `plan.json`/`summary.json`; keep it out of the P12 tool
comparison.

The eval vault sets `alwaysUpdateLinks: true`, so a rename updates links without
a prompt. `seed.files` writes text notes. `seed.binaryFiles` writes base64 bytes,
for example a PDF. The `unchanged` check covers text seeds only.

### The `core` suite and generated vaults

`tool-use` stays the regression tier: 14 cases, saturated at 100%. `core` is the
non-saturated tier for prompt, tool, and model comparisons. It has 24 cases
(eight categories at three levels) and uses the same runner, the same grader,
and `runsPerCase: 3`; pass^3 is the headline number.

The committed baseline is `test/evals/baselines/core.json`, written after the
final 72-run baseline. Until that run, treat the suite as unbaselined. The last
measured run before the final hardening was 62.5% pass^3 (15 of 24 cases) on
`deepseek/deepseek-v4.1-flash`; it belongs to an earlier suite revision, so do
not compare against it. Easy and medium cases seed an `S` vault, hard cases seed
`M`.

Saturation rule: a case that reaches pass^3 in three baselines in a row moves to
the `tool-use` regression tier, and `core` gets a harder variant of it. A case
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

`summary.json` has an `overall` object: `passAtK` (share of cases where every
run passed), `meanPassAt1`, `partialScore`, `totalUsd`, `meanUsd`, `meanTokens`,
`meanModelCalls`, `meanToolCalls`, and `medianCaseMs`. Each case also reports
`passAtK`, `partialScore`, `medianMs`, and `overBudgetRuns` (runs above
`expected.maxToolCalls`; a reporting budget, not a check). `report.md` and the
console print the same numbers.

`--compare` prints the overall rows and a `Flags` column per case: `cost +N%` or
`time +N%` when a value grows more than 20% over the baseline, and `pass -N`
(percentage points) when the pass rate drops. It is read-only: it exits 0 after printing the table. A missing or unreadable
summary file still fails.

Live runs need `AGENTIC_CHAT_API_KEY` and a display. They run locally only; CI
does not run them.

### Local fixture server for web cases

`scripts/eval/fixture-server.ts` is a local HTTP server for future `fetch_url`
eval cases. It binds `127.0.0.1` and uses an OS-assigned port by default, so
cases stay deterministic and offline:

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
prompt that uses `{{fixture}}` with no base URL fails before the e2e starts.
The `core` suite has no such case, so its path is unchanged.

The eval spec sets the `__AGENTIC_CHAT_EVAL_FIXTURE_ORIGIN__` window global to
that base URL's origin in the Obsidian window. `normalizeWebUrl` allows one
exact match and nothing else: the hook is unset by default, so every other
loopback, private, or different-port address stays blocked.

A future web case looks like this:

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
MCP server (about 30 tools for P12 `search_tools`) is a separate change, not
part of this wiring.

### Local fake MCP server for tool-search cases

`scripts/eval/fixture-mcp-server.ts` is a local Streamable HTTP MCP server with
30 tools. It exists for a future P12 `search_tools` case where the model must
find one MCP tool among 30 realistic candidates. It is not wired into the eval
runner yet, and it uses no external network.

```bash
npm run fixture:mcp -- --json
npm run fixture:mcp -- --port 0 --tools 30
```

It binds `127.0.0.1` and uses an OS-assigned port by default. The printed `url`
is the MCP endpoint (`http://127.0.0.1:<port>/mcp`), so it can go straight into
an MCP server setting. `--tools` sets the number of listed tools.

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


## CI

`ci` runs `npm run verify -- ci` on Node 24: app, e2e, and scripts typechecks;
both linters; unit tests plus a coverage report; and the production bundle. The
coverage report is an uploaded artifact, not a threshold, so a low percentage
does not fail the job.

The `e2e` job runs the full deterministic suite in a real Obsidian under
`xvfb-run` with a cached Obsidian runtime:

```bash
xvfb-run -a npm run verify -- e2e
xvfb-run -a npm run verify -- eval --run-scripted
```

The no-key smoke spec is part of the full suite. Live specs skip without
credentials, and the eval step fails on any skip.

Mutation testing is on demand: `npm run mutation`; see
[mutation.md](mutation.md) and [escaped-defects.md](escaped-defects.md).

The `Review gate` workflow requires a verdict comment at the current head. See
[trust.md](trust.md) and [review-ledger.md](review-ledger.md).

The `Witness` workflow runs the verifier self-test on every pull request, then
runs the witness declared in the PR body. A PR that changes `src/` without a
witness block fails, unless it has the `no-behavior-change` label. See
[trust.md](trust.md).
