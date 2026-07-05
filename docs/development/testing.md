# Testing

Run the fast local verification command while iterating:

```bash
npm run verify:fast
```

That command runs typecheck, e2e typecheck, lint, unit tests, production bundle verification, mobile compatibility verification, and the smoke e2e spec.

## Focused tests

```bash
npx vitest run test/settings.test.ts
npx vitest run test/models.test.ts
npx vitest run -t "uses the generic provider model id"
```

## End-to-end tests

```bash
npm run test:e2e
npm run test:e2e -- --spec test/e2e/specs/smoke.e2e.ts
npm run test:e2e:dogfood
npm run test:e2e:mobile
npm run test:e2e:matrix -- --spec test/e2e/specs/smoke.e2e.ts
```

If sandboxed shells block nested e2e localhost listeners, rerun the smoke spec as a top-level command:

```bash
rtk npm run test:e2e -- --spec test/e2e/specs/smoke.e2e.ts
```

## Dogfood e2e

`npm run test:e2e:dogfood` is the expensive high-coverage e2e target. It
generates a fresh adversarial vault plus external workspace under
`logs/dogfood-runs/<run-id>/`, launches real Obsidian through WDIO, drives the
scripted dogfood scenario, then asserts the dogfood invariant oracle and writes a
run report.

The default target is deterministic and does not need live model credentials.
Live model dogfood remains opt-in through `AGENTIC_CHAT_LIVE_*` environment
variables and should not be used as the required CI correctness gate.

## Agentic evals

`npm run eval:agentic` runs deterministic evals over model-visible prompt and
tool metadata. The default suite lives at
`test/evals/agentic-chat/context-and-dogfood.eval.json` and writes artifacts
under `logs/eval-runs/<run-id>/`.

Run the expensive dogfood-backed slice explicitly:

```bash
npm run eval:agentic:dogfood
```

That command launches `npm run test:e2e:dogfood`, then grades the dogfood
manifest, invariant report, and session JSONL for quality and efficiency
findings. To grade an existing dogfood run without rerunning WDIO:

```bash
npm run eval:agentic -- --dogfood-run-id <run-id>
```

Use `--allow-problems --expect-problems` while developing new eval assertions so
the runner can prove that a slice reports known rough edges without failing the
local command. A later opt-in LLM-as-judge slice should sit on top of these
deterministic artifacts rather than replacing them.

Compare prompt, tool-description, or context-packing changes as an A/B eval:

```bash
npm run eval:agentic -- --run-id prompt-baseline --dogfood-run-id <dogfood-run-id>
# apply the candidate prompt/tool/context change
npm run eval:agentic -- --run-id prompt-candidate --dogfood-run-id <same-or-new-dogfood-run-id>
npm run eval:agentic:compare -- \
  logs/eval-runs/prompt-baseline/summary.json \
  logs/eval-runs/prompt-candidate/summary.json \
  --out logs/eval-runs/prompt-candidate/ab-comparison.md
```

Use the same dogfood run id when you want to isolate static prompt/tool metadata
changes. Use separate dogfood run ids when the candidate also changes live or
scripted behavior. Add `--fail-on-regression` to the compare command for CI jobs
that should reject extra findings, larger context/tool schemas, more duplicate
tool calls, more repeated external path actions, more tool errors, or lost cache
hits.

## Deterministic replay

Promote live dogfood bugs into fast replay coverage when the rough edge is in
plugin behavior rather than provider planning quality. Use
`test/helpers/agent-replay.ts` to script assistant turns, exercise the real
`AgentService` tool gates, persist session JSONL, and assert the final transcript
or vault/session evidence. When a replay is about observability or tool
efficiency, write the replayed session JSONL to a temp file and feed it through
`scripts/analyze-session-trace.mjs` so the eval-facing trace contract is covered
too.

Run the LLM-as-judge slice only when you intentionally want a live evaluator
call:

```bash
npm run eval:agentic:judge -- --dogfood-run-id <run-id>
```

The judge runner reads `.env` plus process environment, preferring
`AGENTIC_EVAL_JUDGE_*` and falling back to `OPENWEBUI_*`. It writes a compact
judge packet, redacted config, cached judge result, and Markdown summary under
`logs/eval-runs/<run-id>/`. Judge responses are cached by model, rubric version,
and packet hash under `logs/eval-runs/judge-cache/`.

## Session trace mining

Use the session analyzer before manually reading raw JSONL:

```bash
npm run analyze:session -- logs/dogfood-runs/<run-id>/vault/.obsidian/plugins/agentic-chat/sessions
npm run analyze:session -- logs/dogfood-runs/<run-id>/vault/.obsidian/plugins/agentic-chat/sessions --format markdown
```

The JSON output is stable enough for eval assertions. The Markdown output is
for human triage and highlights per-turn token use, cache hits, active note
context, repeated `external_inspect` path actions, duplicate exact tool calls,
approval denials, and tool errors.

Compare two dogfood runs when validating a prompt/tool-description change:

```bash
npm run analyze:session -- --compare \
  logs/dogfood-runs/<before-run-id>/vault/.obsidian/plugins/agentic-chat/sessions \
  logs/dogfood-runs/<after-run-id>/vault/.obsidian/plugins/agentic-chat/sessions \
  --format markdown
```

Use the comparison to decide whether a change materially improved behavior:
lower repeated path actions, fewer duplicate exact tool calls, fewer tool
errors, smaller token-heavy turns, or clearer cache-hit behavior.

## Live provider tests

Live model-backed specs are opt-in because they spend tokens and need local credentials.

```bash
npm run verify:provider-live
```

`verify:provider-live` runs the OpenRouter guardrail e2e, the OpenAI-compatible
gateway e2e, and `npm run eval:provider-cache-live`. The provider-cache eval
sends the same large stable prompt prefix several times with tiny completions;
the first request may be a cache miss, but at least one later request must report
`cacheRead` tokens. Set `OPENWEBUI_API_KEY` or `OPENWEBUI_API_KEY_FILE`,
`OPENWEBUI_BASE_URL`, and `OPENWEBUI_MODEL`; the cache eval also accepts
`OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_API_KEY_FILE`,
`OPENAI_COMPATIBLE_BASE_URL`, and `OPENAI_COMPATIBLE_MODEL`. It can load a local
dotenv file directly:

```bash
npm run eval:provider-cache-live -- --env-file .env
```

The broader live-provider gate accepts the same env-file option:

```bash
npm run verify:provider-live -- --env-file .env
```

Use the live OpenWebUI or MCP e2e specs only when validating real external calls.
When running a live dogfood spec through `test:e2e:dogfood`, pass
`--skip-post-invariants` and let the live spec write its own report; the default
post-run invariant oracle is scoped to the synthetic scripted dogfood manifest.
Live dogfood manifests can set `maxRepeatedExternalReadCount` to surface
repeated `external_inspect` reads as warnings without failing the run.
