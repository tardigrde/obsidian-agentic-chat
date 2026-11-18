# Verification

Lane internals. Read [testing.md](testing.md) first: it says what to run. This
page explains how the lanes run and what can make them lie. Evals:
[evals.md](evals.md). Witness and agent review: [trust.md](trust.md).

Each `npm run verify -- <lane>` run writes `logs/verify/<timestamp>/` with one
log per step, `summary.json`, `summary.md`, and `run-result.json` (git head,
mode, counts per tier, per-test rows for unit steps). It prints one pass/fail
table and a per-tier counts line, and appends one line to `logs/history.jsonl`
in the main worktree (`npm run tests:status` reads it). A retired lane name
(`fast`, `ci`, `cloud`, `smoke`, `upgrade`, `e2e`, `dogfood`, `audit`, `all`)
exits 2 and names its replacement.

## Fake green

Check the observation method before you trust the result:

- **Stale bundle.** `main.js` is gitignored but drives every local run. `check`
  builds the production bundle first; `app` builds the e2e bundle.
- **Silent skip.** Live specs skip without `AGENTIC_CHAT_API_KEY`. Exit 0 with
  zero passing tests proves nothing. Read the counts.
- **Wrong vault.** Dogfood and probes use generated vaults. Check the run id in
  the artifact path.
- **Cached plugin state.** Disable and re-enable the plugin, or check its version
  in the UI, before you assert.
- **Existence instead of content.** `toExist()` on a container does not prove the
  feature rendered. Assert text or layout.
- **Mocking the subject.** A unit test whose mock implements the behavior under
  test cannot catch a regression.
- **Proxy noise.** `ERR_NO_SUPPORTED_PROXIES` means Obsidian died before the
  feature ran. See [Proxy](#proxy).
- **Scripted recording.** Every run result states `mode: live`, `scripted`, or
  `static`. Never present scripted as live.

## Real Obsidian runs

### Nested display

`app`, `eval --suite core`, and the dogfood runs open real Obsidian windows. On
a desktop, each window steals the cursor. Run them on a nested Xephyr display:

```bash
npm run nested -- npm run verify -- app smoke
npm run nested -- npm run eval:tool-use -- --suite test/evals/tool-use/core.eval.json --runs 3 --env-file .env
```

`npm run nested` starts Xephyr on a free display, passes `DISPLAY` to the
command, and stops Xephyr when the command exits. It is a real GUI Obsidian, not
`AGENTIC_CHAT_E2E_HEADLESS=1` (headless has no accessibility tree). Use
`--display :N` to reuse a running Xephyr and `--screen 390x844` for the narrow
viewport. Probes and chaos own their display.

### Without a display

A cloud sandbox cannot start Obsidian. Run `npm run verify -- check --no-app`
there and let CI run the app jobs. Do not make a UI claim from a cloud run; say
which claim needs a CI `e2e` run or a local app run.

### Driver and ports

`scripts/run-e2e.ts` resolves the matching `obsidian-launcher` chromedriver,
starts it on a fixed low localhost port (`9515`-`9520`), and points WDIO at it
with `WDIO_SKIP_DRIVER_SETUP=1`. This avoids random high-port `bind() failed`
errors on WSL and behind proxies. If a sandbox blocks nested localhost
listeners, run `npm run verify -- app smoke` as a top-level command.

### Proxy

Keep the WDIO/chromedriver localhost control plane off the corporate proxy.
`wdio.conf.mts` strips proxy vars from chromedriver and passes a normalized proxy
URL to Obsidian. Chromium wants `scheme://host:port` without the trailing slash
common in `HTTP_PROXY`. If Obsidian reports `net::ERR_NO_SUPPORTED_PROXIES`,
check that flag first. Override with `AGENTIC_CHAT_E2E_PROXY_SERVER` and
`AGENTIC_CHAT_E2E_PROXY_BYPASS_LIST`.

### Artifacts

Failed app tests write `logs/e2e-artifacts/`: a screenshot, browser console
logs, WDIO metadata, Obsidian UI text, redacted plugin settings, and the latest
sandbox session JSONL.

### Live specs

Live specs live in `test/e2e/live/` and spend tokens. Run them only to validate
real calls:

```bash
AGENTIC_CHAT_API_KEY=sk-or-... \
AGENTIC_CHAT_BASE_URL=https://openrouter.ai/api/v1 \
AGENTIC_CHAT_MODEL=openrouter/auto \
npm run verify -- live test/e2e/live/openwebui-live.e2e.ts

AGENTIC_CHAT_E2E_MCP_URL=https://mcp.context7.com/mcp npm run verify -- live test/e2e/live/mcp-live.e2e.ts
```

The MCP spec skips when `AGENTIC_CHAT_E2E_MCP_URL` is unset. Read the passing
count. Live dogfood runbook:
[`live-dogfood.md`](https://github.com/tardigrde/obsidian-agentic-chat/blob/main/docs/development/live-dogfood.md)
(maintainer only, not on the site).

## Test helpers worth knowing

- **Upgrade fixtures.** `test/fixtures/releases/<version>/` holds the
  `data.json`, fake `secrets.json`, and session JSONL a release wrote.
  `test/upgrade-fixtures.test.ts` loads each through HEAD's load path (unit
  suite). After a release: `npm run capture:release-fixtures -- <version>`.
- **Multi-instance harness.** `test/helpers/interleave.ts` wraps an adapter so
  each call yields a seeded number of macrotask turns. Run two instances under
  many seeds and assert invariants (`test/session-multi-instance.test.ts`). A
  failing seed replays exactly. Use it for any state that two tabs share.
- **Deterministic replay.** `test/helpers/agent-replay.ts` scripts assistant
  turns through the real `AgentService` gates. Use it to pin a live bug. See
  [evals.md](evals.md#deterministic-replay).

## Exploration (leads, not proof)

- **Recorded runs** (`@app`): `npm run verify -- app --record <scenario>`
  records one of the two scenarios in `test/e2e/probe/scenarios/`
  (`layout-smoke`, `live-chat --live`) on an isolated display and writes
  `logs/probes/<ts>-<name>/` (`session.mp4`, `metrics.json`, `report.md`). A run
  that executes no test fails; a used `--out` is refused.
- **Chaos explore** (`@app`): `npm run verify -- explore --mode explore --live`
  drives a seeded throwaway vault with hard caps; `--mode smoke` is the dry
  run. Propose it to the owner after a big change; do not run it unasked.

A lead becomes coverage only when you promote it:

| finding | promotion |
|---|---|
| bug seen in a live run | deterministic replay (`test/helpers/agent-replay.ts`) |
| new user entry point | feature map entry plus an e2e assertion |
| rule broken twice | lint rule, script check, or CI gate |
| layout regression | `test/e2e/support/layout.ts` assertion |
| flaky spec | fix the observation or the fixture; no retry |

## Secret handling

The verify and delegate sinks redact each line before they write it: exact
values of env names that end in `_KEY`, `_TOKEN`, `_SECRET`, or `_PASSWORD`
(8+ characters), and known key shapes (`sk-or-…`, `oc_sk_…`, `ghp_…`,
`github_pat_…`, `sk-…`). `scripts/redact-log.mjs` holds the one implementation.

`npm run check:secrets` scans tracked files and `logs/` and prints a path and a
count, never a value. `--fix` redacts log files in place; a tracked file is never
edited. `--all-worktrees` scans every worktree's `logs/`; `npm run
hooks:install` adds it as a pre-push hook. The sinks and the scanner are guards,
not a security boundary.

Open follow-up (defense in depth, not done yet): keep the live eval key in
Obsidian secret storage, or put a local key-injecting proxy in front of the
plugin, so a raw key never reaches a settings dump or a child `process.env`;
and deny `env`/`printenv`/`.env` reads in the delegate sandbox. A real key leak
into ignored `logs/` (an e2e child printed `process.env`) is why the sinks
redact.

## CI

| job | runs |
|---|---|
| `ci` | `npm run verify -- check --no-app --coverage` on Node 24 (coverage is an artifact, not a threshold), then `npm run docs:build` |
| `e2e` | `verify -- app --prod` (release bundle boots), `verify -- app` (full deterministic suite), and `verify -- app --mobile` (phone-width spec), under `xvfb-run` |
| `dogfood-scripted` | `verify -- app --dogfood` |
| `witness` | the verifier self-test, then the PR's witness block ([trust.md](trust.md)) |
| `review` | advisory report: verdict comment present at head, PR size; never fails |

Live specs never run in CI. Draft PRs run `ci` only. A newer push cancels the
running PR jobs (never on `main`). The `ci`, `e2e`, and `dogfood-scripted` jobs
upload their `run-result.json`; `witness` writes one but does not upload it.
Mutation testing is a weekly local run on the five UI hot spots: `npm run mutation` ([mutation.md](mutation.md)). It prints a score and never gates. CI prints diff coverage for a PR in the `ci` job summary (advisory).
