# AGENTS.md

## Process

Eight skills carry the process. They live in `.agents/skills/` (`.claude/skills`
links there), so Claude Code, OpenCode,
Codex, and other agents that read that convention get the same workflow.

| skill | use for |
|---|---|
| `@factory` | a goal that spans several PRs: split, delegate to opencode workers, review, merge, chaos |
| `@ship-change` | behavior changes, bugs, multi-file work, dependency upgrades |
| `@verify-obsidian-chat` | UI claims, settings, or proof in the real Obsidian app |
| `@probe-feature` | behavior you cannot predict yet, or when the user asks for a recording |
| `@break-change` | adversarial exploratory QA, removal audits, feature-map gaps |
| `@chaos-monkey` | live exploratory run against a seeded throwaway vault after several PRs ship |
| `@verify-pr` | independent verdict on a PR you did not write; red/green witness proof |
| `@worktree` | one task per worktree, env-linked commands, safe cleanup |

Match the weight of the process to the change:

- One-line fix, typo, or a check you can run directly: skip the ceremony and run
  the targeted lane.
- A behavior change that can break something non-obvious, or one that touches
  several files: load `@ship-change`.
- A claim about the UI, settings, or a real user journey: also load
  `@verify-obsidian-chat`.
- "I do not know what correct looks like yet": load `@probe-feature` instead of
  guessing.
- Before a product-cut PR, or when a command or UI entrypoint is deleted: load
  `@break-change`. It is exploratory, not a lane.

Do not load them all at once. Each skill names the next one when it needs it.

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
   metrics. A screenshot alone is not a verdict. When a change touches a
   user-visible entry point (command, button, modal, settings row, mode, tab, or
   panel), attach desktop 1280x1024 and mobile-width 390x844 MP4 clips with
   "what to watch" timestamps, or an explicit waiver in the PR. The 390x844 clip
   is a narrow desktop window, not real Obsidian Mobile.
5. Never commit secrets, vault plugin data, or generated sessions.
6. A merge-ready PR has an independent verdict from an agent that did not write
   it. A green check is not a verdict.
7. Never merge a PR unless the user explicitly says "merge". Green checks are not
   permission.

## Verification

```bash
npm run verify -- fast        # merge gate: typecheck, lints, unit, build, smoke e2e
npm run verify -- ci          # what CI runs
npm run verify -- e2e <spec>  # real Obsidian, one spec
npm run verify -- dogfood     # generated-vault agent flows
npm run verify -- eval        # prompt/tool/context A/B
npm run verify:witness -- --base origin/main --test-file <test> --src <src...>
npm run mutation              # on-demand mutation matrix
```

`npm run verify:fast` is an alias. Full lane reference, evidence rules, and the
fake-green list: [docs/development/verification.md](docs/development/verification.md).
The trust contract, independent verifier, and CI witness gate:
[docs/development/trust.md](docs/development/trust.md). The `review` check needs a
verdict comment at the current head; see the findings ledger at
[docs/development/review-ledger.md](docs/development/review-ledger.md).

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

## Worktrees

One task, one branch, one worktree. `worktree-links` names the local-only files
to symlink, so `.env` is never copied.

```bash
npm run worktree:new -- <name>
npm run worktree:env -- <command>
npm run worktree:list
npm run worktree:cleanup -- --dry-run
```

`--apply` removes only safe worktrees. Read
[docs/development/worktrees.md](docs/development/worktrees.md) and `@worktree`.

## Probes

```bash
npm run probe -- --scenario settings-gate
npm run probe -- --scenario live-chat --live
npm run probe -- --scenario layout-smoke
```

The runner needs `Xvfb` and `ffmpeg`. It records the whole isolated display, so
Obsidian settings popouts are in frame, and writes `session.mp4`, keyframes,
metrics, and a report under `logs/probes/`. See `@probe-feature`.

## Chaos monkey

```bash
npm run chaos -- --mode focused --target settings   # capped dry run
npm run chaos -- --mode generic --max-steps 6       # dry exploration
npm run chaos -- --mode focused --target composer --live \
  --max-steps 2 --max-seconds 180 --max-calls 2 --max-tokens 4000
```

A seeded throwaway vault, an isolated display, real UI actions, and live model
calls when `--live` is set. Hard caps and a cancel file bound every run. See
`@chaos-monkey`.

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
