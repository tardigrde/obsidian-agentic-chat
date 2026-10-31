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
| L2 | `npm run verify -- ci` | types, lint, unit, bundle | ~1 min |
| L3 | `npm run verify -- fast` | merge gate, includes smoke e2e | ~2 min |
| L4 | `npm run verify -- e2e <spec>` | UI wiring, view lifecycle, settings migration | ~1 min |
| L5 | `npm run verify -- dogfood` | multi-tool agent flows in a generated vault | minutes |
| L6 | `npm run verify -- eval` | prompt, tool, context, or provider changes | minutes |

For agent-quality changes, compare two eval runs instead of reading one:

```bash
npm run verify -- eval -- --run-id baseline --dogfood-run-id <run-id>
# apply the change
npm run verify -- eval -- --run-id candidate --dogfood-run-id <same-or-new-run-id>
npm run eval:agentic:compare -- \
  logs/eval-runs/baseline/summary.json \
  logs/eval-runs/candidate/summary.json \
  --out logs/eval-runs/candidate/ab-comparison.md \
  --fail-on-regression
```

## What a pass has to show

- The command, its exit code, and its test counts.
- A witness for the change: the smallest check that fails before and passes after.
  For a bug, run it before the fix and paste both results.
- For UI claims, either a committed e2e assertion or a probe recording plus DOM or
  state metrics. A screenshot or a video alone is not a verdict.
- The artifact path when the lane writes one.

Zero tests, or every test skipped, is a failure. `verify` fails a lane that expects
tests when it can prove nothing ran. If a lane cannot execute because credentials
are missing, say so and run a lane that can.

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
  key.gif
  timeline.json
  metrics.json
  shots/*.png
  report.md
```

The recording is evidence for a human. The assertions extracted from a probe are
what enter `verify`. See `@probe-feature` for the protocol.

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

## CI

`ci` runs `npm run verify -- ci`. The smoke job runs
`xvfb-run -a npm run verify -- smoke`. There is no scheduled lane; dogfood, audits,
and evals run locally or on demand.
