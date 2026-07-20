# AGENTS.md

## Fast Feedback Loop

Use `~/MyTestVault` as the local dogfood vault unless the user names another vault.

Install the current built plugin into a vault:

```bash
npm run install:local -- ~/MyTestVault
```

Run the fastest Obsidian development loop:

```bash
npm run dev:vault -- ~/MyTestVault
```

`dev:vault` installs real plugin files under
`~/MyTestVault/.obsidian/plugins/agentic-chat/`, creates `.hotreload`, and writes esbuild output directly to that plugin directory. For automatic JS reloads inside Obsidian, install and enable `pjeby/hot-reload` in the same vault. If hot reload is unavailable, reload manually from Obsidian DevTools:

```js
await app.plugins.disablePlugin("agentic-chat");
await app.plugins.enablePlugin("agentic-chat");
```

Use the one-command dogfood loop when actively stabilizing:

```bash
npm run dogfood -- ~/MyTestVault
```

`dogfood` enables the local plugin in the vault, enables any installed hot-reload
plugin whose manifest matches "hot reload", starts the direct-to-vault esbuild
watcher, opens the vault through Obsidian's URI handler when available, and
tails local session JSONL plus e2e artifact text/JSON. Use `--once --no-open
--no-tail` for a non-interactive build/install check.

Run local verification in this order while iterating:

```bash
npm run verify:fast
```

That command expands to:

```bash
npm run typecheck
npm run lint
npm test
npm run test:e2e -- --spec test/e2e/specs/smoke.e2e.ts
```

`npm run test:e2e` uses `scripts/run-e2e.ts`: it resolves the matching
`obsidian-launcher` chromedriver, starts it on a fixed low localhost port
(`9515`-`9520`), and points WDIO at it with `WDIO_SKIP_DRIVER_SETUP=1`. This
avoids WSL/proxy failures where WDIO's random high chromedriver port exits with
`bind() failed: Address already in use` / `IPv6 port not available`. To run the
full local suite without spending tokens, clear the live key so the model-backed
guardrail spec skips:

```bash
OPENROUTER_API_KEY= npm run test:e2e
```

`test:e2e` uses `node --import tsx` instead of the `tsx` CLI so the runner does
not need `tsx`'s local IPC pipe. `verify:fast` labels each phase and runs the
same smoke spec, but Codex/sandboxed shells can still block nested e2e local
listen sockets. When it reports that sandbox limitation, rerun the smoke spec as
a top-level command:

```bash
rtk npm run test:e2e -- --spec test/e2e/specs/smoke.e2e.ts
```

Run the live OpenWebUI / OpenAI-compatible e2e only when explicitly validating
real model calls. It spends tokens and needs the local gateway token:

```bash
OPENWEBUI_API_KEY_FILE=/tmp/agentic-chat-openwebui.key \
OPENWEBUI_BASE_URL=https://llm.example/api \
OPENWEBUI_MODEL=gemini-3.1-flash-lite \
HTTP_PROXY=http://192.0.2.10:3128/ \
HTTPS_PROXY=http://192.0.2.10:3128/ \
NO_PROXY=localhost,127.0.0.1,::1 \
npm run test:e2e -- --spec test/e2e/specs/openwebui-live.e2e.ts
```

Keep the WDIO/chromedriver localhost control plane off the corporate proxy.
`wdio.conf.mts` strips proxy env vars from chromedriver and passes a normalized
proxy URL to Obsidian/Electron. If Obsidian reports `net::ERR_NO_SUPPORTED_PROXIES`,
check the proxy flag first: Chromium wants `scheme://host:port` without the
trailing slash that is common in `HTTP_PROXY` / `HTTPS_PROXY`. Override with
`AGENTIC_CHAT_E2E_PROXY_SERVER` and, if needed,
`AGENTIC_CHAT_E2E_PROXY_BYPASS_LIST`.

Failed e2e tests write diagnostics under `logs/e2e-artifacts/`: screenshot,
browser console logs when available, WDIO result metadata, Obsidian UI text,
redacted plugin settings, and the latest sandbox session JSONL when one exists.

Run the full dogfood e2e suite (expensive, generates vault + drives real Obsidian):

```bash
npm run test:e2e:dogfood
```

Run the subagent live dogfood spec alone (needs `OPENROUTER_API_KEY`):

```bash
AGENTIC_CHAT_SUBAGENT_DOGFOOD=true \
OPENROUTER_API_KEY="$(grep -oP '(?<=OPENROUTER_API_KEY=")[^"]+' /home/levente/projects/ai/evals/skill-eval/.env)" \
OPENROUTER_MODEL=openrouter/auto \
npm run test:e2e -- --spec test/e2e/dogfood/subagent-live.dogfood.ts
```

Use single-test commands for tight loops:

```bash
npx vitest run test/settings.test.ts
npx vitest run test/models.test.ts
npx vitest run -t "uses the generic provider model id"
```

OpenWebUI or any OpenAI-compatible gateway is configured in plugin settings:

- Provider: `OpenAI-compatible`
- Base URL: use the gateway base whose `/chat/completions` endpoint is valid; for OpenWebUI this is usually `http://localhost:3000/api`
- API key: paste the gateway bearer token in the plugin settings UI
- Model: paste the model id exposed by the gateway

Secrets stay local. Never commit vault plugin data such as:

```text
~/MyTestVault/.obsidian/plugins/agentic-chat/data.json
~/MyTestVault/.obsidian/plugins/agentic-chat/sessions/
```

Environment variables are allowed for scripts and future live harnesses, but not required for the plugin UI:

```bash
AGENTIC_CHAT_VAULT=~/MyTestVault
OBSIDIAN_VAULT=~/MyTestVault
OPENWEBUI_BASE_URL=http://localhost:3000/api
OPENWEBUI_API_KEY=...
OPENWEBUI_MODEL=...
```
