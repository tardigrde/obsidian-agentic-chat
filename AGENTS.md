# AGENTS.md

## Process

Three skills carry the process. They live in `.agents/skills/`, so OpenCode,
Codex, and other agents that read that convention get the same workflow.

| skill | use for |
|---|---|
| `@ship-change` | behavior changes, bugs, multi-file work, dependency upgrades |
| `@verify-obsidian-chat` | UI claims, settings, or proof in the real Obsidian app |
| `@probe-feature` | behavior you cannot predict yet, or when the user asks for a recording |

Match the weight of the process to the change:

- One-line fix, typo, or a check you can run directly: skip the ceremony and run
  the targeted lane.
- A behavior change that can break something non-obvious, or one that touches
  several files: load `@ship-change`.
- A claim about the UI, settings, or a real user journey: also load
  `@verify-obsidian-chat`.
- "I do not know what correct looks like yet": load `@probe-feature` instead of
  guessing.

Do not load all three at once. Each skill names the next one when it needs it.

Put each rule in the lowest layer that can enforce it: `AGENTS.md` routes,
skills hold procedure, `scripts/` and CI hold gates.

## Non-negotiables

1. Every change needs a witness: the smallest check that fails before and passes
   after. For a bug, run it before the fix and paste both results.
2. Never claim done without running the lowest `verify` lane that can actually
   fail for the risk you introduced.
3. Report test counts, not only exit codes. Zero tests or all tests skipped is a
   failure, not a pass.
4. UI claims need a committed e2e assertion or a probe recording plus DOM/state
   metrics. A screenshot alone is not a verdict.
5. Never commit secrets, vault plugin data, or generated sessions.

## Verification

```bash
npm run verify -- fast        # merge gate: typecheck, lints, unit, build, smoke e2e
npm run verify -- ci          # what CI runs
npm run verify -- e2e <spec>  # real Obsidian, one spec
npm run verify -- dogfood     # generated-vault agent flows
npm run verify -- eval        # prompt/tool/context A/B
```

`npm run verify:fast` is an alias. Full lane reference, evidence rules, and the
fake-green list: [docs/development/verification.md](docs/development/verification.md).

Use single tests for tight loops:

```bash
npm run verify -- change test/settings.test.ts
npm run verify -- change "uses the generic provider model id"
```

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

## Probes

```bash
npm run probe -- --scenario settings-gate
npm run probe -- --scenario live-chat --live
npm run probe -- --scenario layout-smoke
```

The runner needs `Xvfb` and `ffmpeg`. It records the whole isolated display, so
Obsidian settings popouts are in frame, and writes `session.mp4`, keyframes,
metrics, and a report under `logs/probes/`. See `@probe-feature`.

## Real Obsidian e2e

`npm run verify -- e2e <spec>` uses `scripts/run-e2e.ts`: it resolves the matching
`obsidian-launcher` chromedriver, starts it on a fixed low localhost port
(`9515`-`9520`), and points WDIO at it with `WDIO_SKIP_DRIVER_SETUP=1`. This avoids
random high-port `bind() failed` errors on WSL and behind proxies.

If a sandbox blocks nested e2e localhost listeners, rerun the smoke lane as a
top-level command:

```bash
rtk npm run verify -- smoke
```

Live model specs spend tokens. Run them only when validating real calls:

```bash
AGENTIC_CHAT_API_KEY=sk-or-... \
AGENTIC_CHAT_BASE_URL=https://openrouter.ai/api/v1 \
AGENTIC_CHAT_MODEL=openrouter/auto \
npm run verify -- e2e test/e2e/specs/openwebui-live.e2e.ts
```

## Proxy

Keep the WDIO/chromedriver localhost control plane off the corporate proxy.
`wdio.conf.mts` strips proxy vars from chromedriver and passes a normalized proxy
URL to Obsidian/Electron. Chromium wants `scheme://host:port` without the trailing
slash common in `HTTP_PROXY` / `HTTPS_PROXY`. If Obsidian reports
`net::ERR_NO_SUPPORTED_PROXIES`, check that flag first. Override with
`AGENTIC_CHAT_E2E_PROXY_SERVER` and, if needed,
`AGENTIC_CHAT_E2E_PROXY_BYPASS_LIST`.

## Artifacts

Failed e2e tests write diagnostics under `logs/e2e-artifacts/`: screenshot,
browser console logs when available, WDIO result metadata, Obsidian UI text,
redacted plugin settings, and the latest sandbox session JSONL.

Design-audit screenshots (`logs/design-audit/<ts>-<mode>/`, 42 PNGs per mode):

```bash
npm run verify -- audit                # sidebar (default 300px)
npm run verify -- audit wide           # 760px
npm run verify -- audit mobile         # 390px
npm run verify -- audit fullscreen
```

## Dogfood and evals

```bash
npm run verify -- dogfood
AGENTIC_CHAT_SUBAGENT_DOGFOOD=true \
AGENTIC_CHAT_API_KEY="<key>" \
AGENTIC_CHAT_MODEL=openrouter/auto \
npm run verify -- e2e test/e2e/dogfood/subagent-live.dogfood.ts
```

Agentic evals and trace mining are documented in
[docs/development/verification.md](docs/development/verification.md).

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
